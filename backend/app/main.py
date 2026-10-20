
from fastapi import FastAPI, Depends, HTTPException
from sqlalchemy.orm import Session

from .database import Base, engine, SessionLocal
from . import models, schemas


from datetime import datetime, timezone
from zoneinfo import ZoneInfo


from fastapi import UploadFile, File, Form
from sqlalchemy.exc import SQLAlchemyError

from .face_service import (
    embedding_from_bytes,
    embedding_to_bytes,
    embedding_from_storage,
    compare_vectors,
)




Base.metadata.create_all(bind=engine)

app = FastAPI(
    title="Smart Surveillance API",
    description="Backend for the Smart Surveillance CCTV application",
    version="0.3.0",
)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@app.get("/")
def home():
    return {
        "message": "Smart Surveillance API is running!",
        "status": "online",
    }


@app.get("/health")
def health_check():
    return {"status": "healthy"}



@app.post("/users", response_model=schemas.UserResponse, status_code=201)
def create_user(
    user_data: schemas.UserCreate,
    db: Session = Depends(get_db),
):
    existing_user = db.query(models.User).filter(
        models.User.email == user_data.email
    ).first()

    if existing_user:
        raise HTTPException(
            status_code=409,
            detail="A user with this email already exists",
        )

    new_user = models.User(
        name=user_data.name,
        email=user_data.email,
    )

    db.add(new_user)
    db.commit()
    db.refresh(new_user)

    return new_user



@app.post("/locations", response_model=schemas.LocationResponse)
def create_location(
    location: schemas.LocationCreate,
    user_id: int,
    db: Session = Depends(get_db),
):
    user = db.query(models.User).filter(
        models.User.id == user_id
    ).first()

    if user is None:
        raise HTTPException(status_code=404, detail="User not found")

    new_location = models.Location(
        name=location.name,
        address=location.address,
        user_id=user.id,
    )

    db.add(new_location)
    db.commit()
    db.refresh(new_location)

    return new_location



@app.post(
    "/locations/{location_id}/cameras",
    response_model=schemas.CameraResponse,
    status_code=201,
)
def create_camera(
    location_id: int,
    camera: schemas.CameraCreate,
    db: Session = Depends(get_db),
):
    location = db.query(models.Location).filter(
        models.Location.id == location_id
    ).first()

    if location is None:
        raise HTTPException(
            status_code=404,
            detail="Location not found",
        )

    new_camera = models.Camera(
        name=camera.name,
        source=camera.source,
        location_id=location.id,
        status="offline",
    )

    db.add(new_camera)
    db.commit()
    db.refresh(new_camera)

    return new_camera


@app.get(
    "/locations/{location_id}/cameras",
    response_model=list[schemas.CameraResponse],
)
def get_cameras(
    location_id: int,
    db: Session = Depends(get_db),
):
    location = db.query(models.Location).filter(
        models.Location.id == location_id
    ).first()

    if location is None:
        raise HTTPException(
            status_code=404,
            detail="Location not found",
        )

    return db.query(models.Camera).filter(
        models.Camera.location_id == location_id
    ).all()



@app.post(
    "/cameras/{camera_id}/events",
    response_model=schemas.DetectionEventResponse,
    status_code=201,
    responses={200: {"description": "Existing event returned"}},
)
def create_detection_event(
    camera_id: int,
    event: schemas.DetectionEventCreate,
    db: Session = Depends(get_db),
):
    camera = db.query(models.Camera).filter(
        models.Camera.id == camera_id
    ).first()

    if camera is None:
        raise HTTPException(
            status_code=404,
            detail="Camera not found",
        )

    # Return the existing event if this key was already processed.
    if event.event_key:
        existing_event = db.query(models.DetectionEvent).filter(
            models.DetectionEvent.event_key == event.event_key
        ).first()

        if existing_event:
            if existing_event.camera_id != camera_id:
                raise HTTPException(
                    status_code=409,
                    detail="Event key already belongs to another camera",
                )

            from fastapi.responses import JSONResponse
            return JSONResponse(
                status_code=200,
                content=schemas.DetectionEventResponse.model_validate(
                    existing_event
                ).model_dump(mode="json"),
            )

    event_data = event.model_dump(
        exclude={"timestamp", "event_key"}
    )

    event_timestamp = event.timestamp or datetime.now(timezone.utc)

    if event_timestamp.tzinfo is None:
        event_timestamp = event_timestamp.replace(
            tzinfo=ZoneInfo("Asia/Kolkata")
        )

    event_timestamp = event_timestamp.astimezone(timezone.utc)

    new_event = models.DetectionEvent(
        **event_data,
        event_key=event.event_key,
        camera_id=camera.id,
        timestamp=event_timestamp,
    )

    db.add(new_event)

    try:
        db.commit()
    except Exception:
        db.rollback()

        # Another request may have saved the same key concurrently.
        if event.event_key:
            existing_event = db.query(models.DetectionEvent).filter(
                models.DetectionEvent.event_key == event.event_key
            ).first()

            if existing_event and existing_event.camera_id == camera_id:
                return existing_event

        raise

    db.refresh(new_event)
    return new_event


@app.get(
    "/locations/{location_id}/events",
    response_model=list[schemas.DetectionEventResponse],
)
def get_location_events(
    location_id: int,
    db: Session = Depends(get_db),
):
    location = db.query(models.Location).filter(
        models.Location.id == location_id
    ).first()

    if location is None:
        raise HTTPException(
            status_code=404,
            detail="Location not found",
        )

    return (
        db.query(models.DetectionEvent)
        .join(models.Camera)
        .filter(models.Camera.location_id == location_id)
        .order_by(models.DetectionEvent.timestamp.desc())
        .all()
    )



# ---------------------------------------------------------
# FACE ENROLLMENT API
# ---------------------------------------------------------
# Development prototype only.
# Do not expose these endpoints to a network before adding
# authentication, authorization, and appropriate protections.

MAX_FACE_UPLOAD_BYTES = 8 * 1024 * 1024
MAX_FACE_UPLOADS = 4



@app.post("/face-profiles/{user_id}/enroll", status_code=201)
async def enroll_face_profile(
    user_id: int,
    display_name: str = Form(..., min_length=1, max_length=100),
    consent_given: bool = Form(...),
    image: UploadFile = File(...),
    relationship_label: str | None = Form(default=None, max_length=100),
    source: str = Form(default="upload"),
    db: Session = Depends(get_db),
):
    """Enroll one person using one uploaded or browser-captured image."""

    if not consent_given:
        raise HTTPException(
            status_code=400,
            detail="Explicit consent is required before enrollment.",
        )

    if source not in {"upload", "live_capture"}:
        raise HTTPException(
            status_code=400,
            detail="source must be 'upload' or 'live_capture'.",
        )

    allowed_types = {"image/jpeg", "image/png", "image/webp"}

    if image.content_type not in allowed_types:
        raise HTTPException(
            status_code=415,
            detail="Use a JPEG, PNG, or WebP image.",
        )

    user = db.query(models.User).filter(
        models.User.id == user_id
    ).first()

    if user is None:
        raise HTTPException(status_code=404, detail="User not found.")

    image_bytes = await image.read(MAX_FACE_UPLOAD_BYTES + 1)
    await image.close()

    if len(image_bytes) > MAX_FACE_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail="Image must be no larger than 8 MB.",
        )

    try:
        vector = embedding_from_bytes(image_bytes)
        stored_vector = embedding_to_bytes(vector)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    profile = models.FaceProfile(
        user_id=user_id,
        display_name=display_name.strip(),
        relationship_label=(
            relationship_label.strip() if relationship_label else None
        ),
        consent_given=True,
        is_active=True,
    )

    try:
        db.add(profile)
        db.flush()

        sample = models.FaceSample(
            profile_id=profile.id,
            embedding=stored_vector,
            source=source,
        )

        db.add(sample)
        db.commit()
        db.refresh(profile)

    except SQLAlchemyError as exc:
        db.rollback()
        raise HTTPException(
            status_code=500,
            detail="Could not save the enrollment. No success was recorded.",
        ) from exc

    return {
        "message": "Face sample enrolled.",
        "profile_id": profile.id,
        "user_id": profile.user_id,
        "display_name": profile.display_name,
        "source": source,
        "samples_saved": 1,
        "identity_verified": False,
    }


@app.get("/face-profiles/{user_id}")
def list_face_profiles(
    user_id: int,
    db: Session = Depends(get_db),
):
    """List profiles for a Sentinel user without returning embeddings."""

    user = db.query(models.User).filter(
        models.User.id == user_id
    ).first()

    if user is None:
        raise HTTPException(status_code=404, detail="User not found.")

    profiles = (
        db.query(models.FaceProfile)
        .filter(models.FaceProfile.user_id == user_id)
        .order_by(models.FaceProfile.id.asc())
        .all()
    )

    return [
        {
            "profile_id": profile.id,
            "display_name": profile.display_name,
            "relationship_label": profile.relationship_label,
            "is_active": profile.is_active,
            "consent_given": profile.consent_given,
            "created_at": profile.created_at,
            "sample_count": len(profile.samples),
        }
        for profile in profiles
    ]


@app.post("/face-profiles/{user_id}/verify")
async def compare_face_candidate(
    user_id: int,
    image: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    """Compare one face against enrolled samples for evaluation only.

    This returns a ranked similarity candidate, NOT a verified identity.
    It does not create CCTV events or authorize access.
    """

    allowed_types = {"image/jpeg", "image/png", "image/webp"}
    if image.content_type not in allowed_types:
        raise HTTPException(
            status_code=415,
            detail="Use a JPEG, PNG, or WebP image.",
        )

    user = db.query(models.User).filter(
        models.User.id == user_id
    ).first()

    if user is None:
        raise HTTPException(status_code=404, detail="User not found.")

    image_bytes = await image.read(MAX_FACE_UPLOAD_BYTES + 1)
    await image.close()

    if len(image_bytes) > MAX_FACE_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail="Image must be no larger than 8 MB.",
        )

    try:
        query_vector = embedding_from_bytes(image_bytes)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    profiles = (
        db.query(models.FaceProfile)
        .filter(
            models.FaceProfile.user_id == user_id,
            models.FaceProfile.is_active.is_(True),
            models.FaceProfile.consent_given.is_(True),
        )
        .all()
    )

    candidates = []

    for profile in profiles:
        best_score = None
        usable_samples = 0

        for sample in profile.samples:
            try:
                reference_vector = embedding_from_storage(sample.embedding)
                score = compare_vectors(query_vector, reference_vector)
            except (ValueError, TypeError):
                continue

            usable_samples += 1
            if best_score is None or score > best_score:
                best_score = score

        if usable_samples and best_score is not None:
            candidates.append({
                "profile_id": profile.id,
                "display_name": profile.display_name,
                "similarity": round(float(best_score), 4),
                "samples_compared": usable_samples,
            })

    candidates.sort(
        key=lambda candidate: candidate["similarity"],
        reverse=True,
    )

    return {
        "message": (
            "Similarity comparison complete. "
            "Results are candidates, not identity verification."
        ),
        "user_id": user_id,
        "identity_verified": False,
        "candidates": candidates,
    }


@app.delete("/face-profiles/{user_id}/{profile_id}")
def delete_face_profile(
    user_id: int,
    profile_id: int,
    db: Session = Depends(get_db),
):
    """Delete a profile and its samples from the database."""

    profile = (
        db.query(models.FaceProfile)
        .filter(
            models.FaceProfile.id == profile_id,
            models.FaceProfile.user_id == user_id,
        )
        .first()
    )

    if profile is None:
        raise HTTPException(
            status_code=404,
            detail="Face profile not found for this user.",
        )

    try:
        db.delete(profile)
        db.commit()
    except SQLAlchemyError as exc:
        db.rollback()
        raise HTTPException(
            status_code=500,
            detail="Could not delete the face profile.",
        ) from exc

    return {
        "message": "Face profile and its samples deleted.",
        "profile_id": profile_id,
        "user_id": user_id,
    }
