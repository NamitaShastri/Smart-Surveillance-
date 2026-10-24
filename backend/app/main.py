import mimetypes
import os
import re
import shutil
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote
from zoneinfo import ZoneInfo

from fastapi.concurrency import run_in_threadpool
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from sqlalchemy import func, inspect, text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from . import auth, models, schemas, video_tools
from .database import Base, engine, SessionLocal
from .face_service import (
    embedding_from_bytes,
    faces_from_bytes,
    embedding_to_bytes,
    embedding_from_storage,
    compare_vectors,
)

Base.metadata.create_all(bind=engine)


def add_missing_columns():
    """create_all() never alters existing tables, so add the new columns once."""
    wanted = {
        "users": {"password_hash": "VARCHAR(255)"},
        "locations": {"type": "VARCHAR(30) NOT NULL DEFAULT 'Other'"},
    }
    inspector = inspect(engine)
    with engine.begin() as conn:
        for table, columns in wanted.items():
            existing = {c["name"] for c in inspector.get_columns(table)}
            for name, ddl in columns.items():
                if name not in existing:
                    conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {name} {ddl}"))


add_missing_columns()

app = FastAPI(
    title="Smart Surveillance API",
    description="Backend for the Smart Surveillance CCTV application",
    version="0.4.0",
)

# Recordings are saved by the YOLO pipeline into runs/detect/camera_<id>/
PROJECT_ROOT = Path(__file__).resolve().parents[2]
RECORDINGS_ROOT = PROJECT_ROOT / "runs" / "detect"

ALLOWED_VIDEO_EXTENSIONS = {".avi", ".mp4", ".mkv", ".mov"}

ALLOWED_ORIGINS = [
    o.strip()
    for o in os.environ.get(
        "SENTINEL_CORS_ORIGINS",
        "http://127.0.0.1:5500,http://localhost:5500,http://127.0.0.1:5501,http://localhost:5501",
    ).split(",")
    if o.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "X-API-Key"],
)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# ---------------------------------------------------------
# AUTH HELPERS
# ---------------------------------------------------------

def optional_user(
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> models.User | None:
    if not authorization or not authorization.startswith("Bearer "):
        return None
    payload = auth.read_token(authorization[7:].strip())
    return db.get(models.User, payload["sub"]) if payload else None


def current_user(user: models.User | None = Depends(optional_user)) -> models.User:
    if user is None:
        raise HTTPException(
            status_code=401,
            detail="Please sign in.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return user


def pipeline_ok(x_api_key: str | None) -> bool:
    """The detection pipeline authenticates with a shared key (open if no key is set)."""
    if not auth.PIPELINE_KEY:
        return True
    return bool(x_api_key) and auth.hmac.compare_digest(x_api_key, auth.PIPELINE_KEY)


def require_self(user_id: int, user: models.User | None) -> None:
    if user is None:
        raise HTTPException(status_code=401, detail="Please sign in.")
    if user.id != user_id:
        raise HTTPException(status_code=403, detail="You can only access your own data.")


def owned_location(db: Session, location_id: int, user: models.User) -> models.Location:
    location = db.get(models.Location, location_id)
    if location is None or location.user_id != user.id:
        raise HTTPException(status_code=404, detail="Location not found")
    return location


def owned_camera(db: Session, camera_id: int, user: models.User) -> models.Camera:
    camera = db.get(models.Camera, camera_id)
    if camera is None or camera.location.user_id != user.id:
        raise HTTPException(status_code=404, detail="Camera not found")
    return camera


@app.get("/")
def home():
    return {"message": "Smart Surveillance API is running!", "status": "online"}


@app.get("/health")
def health_check():
    return {"status": "healthy"}


# ---------------------------------------------------------
# RECORDINGS (per camera: runs/detect/camera_<id>/)
# ---------------------------------------------------------

def valid_video_name(filename: str) -> bool:
    return bool(filename) and filename == Path(filename).name and (
        Path(filename).suffix.lower() in ALLOWED_VIDEO_EXTENSIONS
    )


@app.get("/recordings")
def list_recordings(
    camera_id: int | None = None,
    user: models.User = Depends(current_user),
    db: Session = Depends(get_db),
):
    """List saved videos for one of your cameras, or for all of them."""
    if camera_id is not None:
        cameras = [owned_camera(db, camera_id, user)]
    else:
        cameras = (
            db.query(models.Camera)
            .join(models.Location)
            .filter(models.Location.user_id == user.id)
            .all()
        )

    recordings = []
    for camera in cameras:
        folder = RECORDINGS_ROOT / f"camera_{camera.id}"
        if not folder.is_dir():
            continue
        for file_path in folder.iterdir():
            if not file_path.is_file() or file_path.suffix.lower() not in ALLOWED_VIDEO_EXTENSIONS:
                continue
            stat = file_path.stat()
            modified_at = datetime.fromtimestamp(stat.st_mtime).astimezone()
            # Files named like 2026-10-22_16h belong to that hour, whenever they were written.
            slot = re.fullmatch(r"(\d{4})-(\d{2})-(\d{2})_(\d{2})h", file_path.stem)
            recorded_at = (
                datetime(*map(int, slot.groups())).astimezone() if slot else modified_at
            )
            recordings.append({
                "filename": file_path.name,
                "camera_id": camera.id,
                "camera_name": camera.name,
                "size_bytes": stat.st_size,
                "modified_at": modified_at.isoformat(),
                "recorded_at": recorded_at.isoformat(),
                "playback_url": f"/recordings/{camera.id}/{quote(file_path.name)}",
                "format": file_path.suffix.lower().lstrip("."),
                "_mtime": stat.st_mtime,
            })

    recordings.sort(key=lambda item: item["_mtime"], reverse=True)
    for item in recordings:
        del item["_mtime"]
    return recordings


@app.post("/recordings/{camera_id}/{filename}/playback-token")
def recording_playback_token(
    camera_id: int,
    filename: str,
    user: models.User = Depends(current_user),
    db: Session = Depends(get_db),
):
    """A <video> tag can't send an Authorization header, so hand out a short-lived link."""
    owned_camera(db, camera_id, user)
    if not valid_video_name(filename) or not (RECORDINGS_ROOT / f"camera_{camera_id}" / filename).is_file():
        raise HTTPException(status_code=404, detail="Recording not found")
    token = auth.make_token(user.id, scope="media", ttl=auth.MEDIA_TTL, cam=camera_id, fn=filename)
    return {
        "url": f"/recordings/{camera_id}/{quote(filename)}?token={token}",
        "expires_in": auth.MEDIA_TTL,
    }


@app.get("/recordings/{camera_id}/{filename}")
def play_recording(camera_id: int, filename: str, token: str):
    """Stream a saved video (needs the short-lived token from playback-token)."""
    payload = auth.read_token(token, scope="media")
    if not payload or payload.get("cam") != camera_id or payload.get("fn") != filename:
        raise HTTPException(status_code=403, detail="Invalid or expired playback link")
    if not valid_video_name(filename):
        raise HTTPException(status_code=400, detail="Invalid recording filename")

    file_path = RECORDINGS_ROOT / f"camera_{camera_id}" / filename
    if not file_path.is_file():
        raise HTTPException(status_code=404, detail="Recording not found")

    return FileResponse(
        path=file_path,
        media_type=mimetypes.guess_type(file_path.name)[0] or "application/octet-stream",
        content_disposition_type="inline",
    )


@app.delete("/recordings/{camera_id}/{filename}")
def delete_recording(
    camera_id: int,
    filename: str,
    data: schemas.RecordingDeleteRequest,
    user: models.User = Depends(current_user),
    db: Session = Depends(get_db),
):
    """Permanently delete one saved recording. A reason is required and is kept in an audit log."""
    owned_camera(db, camera_id, user)
    if not valid_video_name(filename):
        raise HTTPException(status_code=400, detail="Invalid recording filename")
    file_path = RECORDINGS_ROOT / f"camera_{camera_id}" / filename
    if not file_path.is_file():
        raise HTTPException(status_code=404, detail="Recording not found")

    db.add(models.RecordingDeletion(
        camera_id=camera_id,
        filename=filename,
        reason=data.reason,
        size_bytes=file_path.stat().st_size,
        deleted_by=user.id,
    ))
    try:
        db.flush()
        file_path.unlink()
        db.commit()
    except (OSError, SQLAlchemyError) as exc:
        db.rollback()
        raise HTTPException(status_code=500, detail="Could not delete the recording.") from exc
    return {"message": "Recording deleted.", "camera_id": camera_id, "filename": filename}


# ---------------------------------------------------------
# USERS & LOGIN
# ---------------------------------------------------------

@app.post("/users", response_model=schemas.UserResponse, status_code=201)
def create_user(user_data: schemas.UserCreate, db: Session = Depends(get_db)):
    if db.query(models.User).filter(func.lower(models.User.email) == user_data.email).first():
        raise HTTPException(status_code=409, detail="A user with this email already exists")

    new_user = models.User(
        name=user_data.name,
        email=user_data.email,
        password_hash=auth.hash_password(user_data.password),
    )
    db.add(new_user)
    db.commit()
    db.refresh(new_user)
    return new_user


@app.post("/auth/login", response_model=schemas.TokenResponse)
def login(data: schemas.LoginRequest, db: Session = Depends(get_db)):
    email = data.email.strip().lower()
    auth.check_throttle(email)

    user = db.query(models.User).filter(func.lower(models.User.email) == email).first()
    stored = user.password_hash if user and user.password_hash else auth.DUMMY_HASH
    password_ok = auth.verify_password(data.password, stored)

    if not (user and user.password_hash and password_ok):
        auth.record_failure(email)
        raise HTTPException(status_code=401, detail="Incorrect email or password.")

    auth.clear_failures(email)
    return schemas.TokenResponse(
        access_token=auth.make_token(user.id),
        user=schemas.UserResponse.model_validate(user),
    )


@app.get("/auth/me", response_model=schemas.UserResponse)
def read_me(user: models.User = Depends(current_user)):
    return user


@app.patch("/users/{user_id}", response_model=schemas.UserResponse)
def update_user(
    user_id: int,
    data: schemas.UserUpdate,
    user: models.User = Depends(current_user),
    db: Session = Depends(get_db),
):
    require_self(user_id, user)

    if data.email is not None and data.email != user.email.lower():
        taken = db.query(models.User).filter(
            func.lower(models.User.email) == data.email, models.User.id != user.id
        ).first()
        if taken:
            raise HTTPException(status_code=409, detail="A user with this email already exists")
        user.email = data.email
    if data.name is not None:
        user.name = data.name

    db.commit()
    db.refresh(user)
    return user


@app.post("/users/{user_id}/password")
def change_password(
    user_id: int,
    data: schemas.PasswordChange,
    user: models.User = Depends(current_user),
    db: Session = Depends(get_db),
):
    require_self(user_id, user)
    if not user.password_hash or not auth.verify_password(data.current_password, user.password_hash):
        raise HTTPException(status_code=400, detail="Current password is incorrect.")
    user.password_hash = auth.hash_password(data.new_password)
    db.commit()
    return {"message": "Password updated."}


# ---------------------------------------------------------
# LOCATIONS, CAMERAS, EVENTS
# ---------------------------------------------------------

@app.post("/locations", response_model=schemas.LocationResponse)
def create_location(
    location: schemas.LocationCreate,
    user: models.User = Depends(current_user),
    db: Session = Depends(get_db),
):
    new_location = models.Location(
        name=location.name.strip(),
        address=location.address,
        type=location.type,
        user_id=user.id,
    )
    db.add(new_location)
    db.commit()
    db.refresh(new_location)
    return new_location


@app.get("/users/{user_id}/locations", response_model=list[schemas.LocationResponse])
def get_user_locations(
    user_id: int,
    user: models.User = Depends(current_user),
    db: Session = Depends(get_db),
):
    """List locations belonging to a user."""
    require_self(user_id, user)
    return (
        db.query(models.Location)
        .filter(models.Location.user_id == user_id)
        .order_by(models.Location.id.asc())
        .all()
    )


@app.post("/locations/{location_id}/cameras", response_model=schemas.CameraResponse, status_code=201)
def create_camera(
    location_id: int,
    camera: schemas.CameraCreate,
    user: models.User = Depends(current_user),
    db: Session = Depends(get_db),
):
    location = owned_location(db, location_id, user)
    new_camera = models.Camera(
        name=camera.name.strip(),
        source=camera.source,
        location_id=location.id,
        status="offline",
    )
    db.add(new_camera)
    db.commit()
    db.refresh(new_camera)
    return new_camera


@app.get("/locations/{location_id}/cameras", response_model=list[schemas.CameraResponse])
def get_cameras(
    location_id: int,
    user: models.User = Depends(current_user),
    db: Session = Depends(get_db),
):
    owned_location(db, location_id, user)
    return db.query(models.Camera).filter(models.Camera.location_id == location_id).all()


@app.patch("/cameras/{camera_id}/status", response_model=schemas.CameraResponse)
def update_camera_status(
    camera_id: int,
    data: schemas.CameraStatusUpdate,
    db: Session = Depends(get_db),
    user: models.User | None = Depends(optional_user),
    x_api_key: str | None = Header(default=None),
):
    """Mark a camera online/offline (the pipeline or the camera's owner)."""
    camera = db.get(models.Camera, camera_id)
    if not pipeline_ok(x_api_key):
        if user is None:
            raise HTTPException(status_code=401, detail="Please sign in.")
        if camera is None or camera.location.user_id != user.id:
            raise HTTPException(status_code=404, detail="Camera not found")
    if camera is None:
        raise HTTPException(status_code=404, detail="Camera not found")
    camera.status = data.status
    db.commit()
    db.refresh(camera)
    return camera


MAX_UPLOAD_BYTES = 300 * 1024 * 1024


def parse_client_time(value: str | None) -> datetime:
    """When the clip really ended (sent by the browser); never later than now."""
    now = datetime.now()
    if not value:
        return now
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return now
    if parsed.tzinfo is not None:
        parsed = parsed.astimezone().replace(tzinfo=None)  # server-local, like datetime.now()
    return min(parsed, now)


@app.post("/cameras/{camera_id}/recordings", status_code=201)
def upload_recording(
    camera_id: int,
    video: UploadFile = File(...),
    ended_at: str | None = Form(default=None),
    user: models.User = Depends(current_user),
    db: Session = Depends(get_db),
):
    """Save a webcam recording (webm/mp4) into the camera's hourly archive."""
    owned_camera(db, camera_id, user)
    folder = RECORDINGS_ROOT / f"camera_{camera_id}"
    folder.mkdir(parents=True, exist_ok=True)
    staged = folder / f".upload_{uuid.uuid4().hex}.part"
    try:
        size = 0
        with staged.open("wb") as out:
            while chunk := video.file.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_UPLOAD_BYTES:
                    raise HTTPException(status_code=413, detail="Recording is too large (limit 300 MB).")
                out.write(chunk)
        if size == 0:
            raise HTTPException(status_code=400, detail="The recording is empty.")
        try:
            written = video_tools.save_live_recording(staged, folder, parse_client_time(ended_at))
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    finally:
        staged.unlink(missing_ok=True)
    return {
        "camera_id": camera_id,
        "recordings": [{"filename": path.name, "hour": path.stem.split("_")[-1]} for path in written],
    }


@app.delete("/cameras/{camera_id}")
def delete_camera(
    camera_id: int,
    user: models.User = Depends(current_user),
    db: Session = Depends(get_db),
):
    """Delete a camera and its detection events."""
    camera = owned_camera(db, camera_id, user)
    try:
        db.delete(camera)
        db.commit()
    except SQLAlchemyError as exc:
        db.rollback()
        raise HTTPException(status_code=500, detail="Could not delete the camera.") from exc
    return {"message": "Camera deleted.", "camera_id": camera_id}


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
    user: models.User | None = Depends(optional_user),
    x_api_key: str | None = Header(default=None),
):
    camera = db.get(models.Camera, camera_id)

    # Either the detection pipeline (API key) or the camera's owner may post events.
    if not pipeline_ok(x_api_key):
        if user is None:
            raise HTTPException(status_code=401, detail="Please sign in.")
        if camera is None or camera.location.user_id != user.id:
            raise HTTPException(status_code=404, detail="Camera not found")

    if camera is None:
        raise HTTPException(status_code=404, detail="Camera not found")

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


@app.get("/locations/{location_id}/events", response_model=list[schemas.DetectionEventResponse])
def get_location_events(
    location_id: int,
    user: models.User = Depends(current_user),
    db: Session = Depends(get_db),
):
    owned_location(db, location_id, user)
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

# Prototype verification settings.
# Calibrate these values using genuine and different-person test images
# before relying on identity decisions.
# Tune these without editing code, e.g.  $env:SENTINEL_FACE_THRESHOLD = "0.45"
FACE_VERIFICATION_THRESHOLD = float(os.environ.get("SENTINEL_FACE_THRESHOLD", "0.60"))
FACE_MINIMUM_SCORE_GAP = float(os.environ.get("SENTINEL_FACE_GAP", "0.05"))

# The face model is CPU-heavy. It runs in a worker thread (so the API stays responsive
# for everyone else) and one frame at a time (the model is not thread-safe).
_face_lock = threading.Lock()


def embed_face(image_bytes: bytes):
    with _face_lock:
        return embedding_from_bytes(image_bytes)


def detect_faces(image_bytes: bytes):
    """Every usable face in one frame (live camera). One frame at a time, like embed_face."""
    with _face_lock:
        return faces_from_bytes(image_bytes)


def load_reference_index(db: Session, user_id: int):
    """Enrolled, consented profiles with their decoded embeddings: [(id, name, [vectors])]."""
    profiles = (
        db.query(models.FaceProfile)
        .filter(
            models.FaceProfile.user_id == user_id,
            models.FaceProfile.is_active.is_(True),
            models.FaceProfile.consent_given.is_(True),
        )
        .all()
    )
    index = []
    for profile in profiles:
        vectors = []
        for sample in profile.samples:
            try:
                vectors.append(embedding_from_storage(sample.embedding))
            except (ValueError, TypeError):
                continue
        if vectors:
            index.append((profile.id, profile.display_name, vectors))
    return index


def match_vector(index, query_vector) -> dict:
    """Prototype matching rules for one face: threshold, then a minimum gap to the runner-up."""
    candidates = []
    for profile_id, display_name, vectors in index:
        best_score = None
        usable = 0
        for reference_vector in vectors:
            try:
                score = compare_vectors(query_vector, reference_vector)
            except (ValueError, TypeError):
                continue
            usable += 1
            if best_score is None or score > best_score:
                best_score = score
        if usable and best_score is not None:
            candidates.append({
                "profile_id": profile_id,
                "display_name": display_name,
                "similarity": round(float(best_score), 4),
                "samples_compared": usable,
            })

    candidates.sort(key=lambda candidate: candidate["similarity"], reverse=True)

    verified = False
    matched_profile = None
    best_similarity = None
    reason = "no_eligible_candidate"

    if candidates:
        best = candidates[0]
        best_similarity = best["similarity"]
        if best_similarity < FACE_VERIFICATION_THRESHOLD:
            reason = "similarity_below_threshold"
        elif (
            len(candidates) > 1
            and best_similarity - candidates[1]["similarity"] < FACE_MINIMUM_SCORE_GAP
        ):
            reason = "ambiguous_candidates"
        else:
            # Prototype similarity rule passed; this is not a guarantee of real-world identity.
            verified = True
            matched_profile = {"profile_id": best["profile_id"], "display_name": best["display_name"]}
            reason = "prototype_similarity_rule_passed"

    return {
        "verified": verified,
        "matched_profile": matched_profile,
        "best_similarity": best_similarity,
        "reason": reason,
        "candidates": candidates,
    }


@app.on_event("startup")
def warm_up_face_model():
    """Load the face model once at startup, so the first live frame isn't slow."""
    started = time.perf_counter()
    try:
        import cv2
        import numpy as np

        _, jpg = cv2.imencode(".jpg", np.zeros((480, 640, 3), dtype=np.uint8))
        embed_face(jpg.tobytes())
    except ValueError:
        pass  # "no face found" is expected for a blank image; the model is loaded now
    except Exception as exc:  # warm-up is best effort only
        print(f"Face model warm-up skipped: {exc}")
        return
    print(f"Face model ready ({time.perf_counter() - started:.1f}s).")




@app.post("/face-profiles/{user_id}/enroll-multi", status_code=201)
async def enroll_face_profile_multi(
    user_id: int,
    display_name: str = Form(..., min_length=1, max_length=100),
    consent_given: bool = Form(...),
    straight_image: UploadFile = File(...),
    left_image: UploadFile = File(...),
    right_image: UploadFile = File(...),
    relationship_label: str | None = Form(default=None, max_length=100),
    source: str = Form(default="live_capture"),
    db: Session = Depends(get_db),
    current: models.User = Depends(current_user),
):
    """
    Enroll one person using three webcam captures:
    straight, left, and right.

    Extracts and stores face embeddings only; original photos are not saved.
    """

    require_self(user_id, current)

    # 1. Require explicit consent and webcam enrollment.
    if not consent_given:
        raise HTTPException(
            status_code=400,
            detail="Explicit consent is required before enrollment.",
        )

    if source not in {"live_capture", "upload"}:
        raise HTTPException(
            status_code=400,
            detail="Source must be 'live_capture' or 'upload'.",
        )

    # 2. Confirm the user exists.
    user = db.query(models.User).filter(models.User.id == user_id).first()

    if user is None:
        raise HTTPException(
            status_code=404,
            detail="User not found.",
        )

    captures = [
        ("straight", straight_image),
        ("left", left_image),
        ("right", right_image),
    ]

    allowed_types = {
        "image/jpeg",
        "image/png",
        "image/webp",
    }

    stored_embeddings = {}

    # 3. Extract all three embeddings before saving anything.
    try:
        for pose, upload in captures:
            if upload.content_type not in allowed_types:
                raise HTTPException(
                    status_code=415,
                    detail=(
                        f"The {pose} capture must be a JPEG, PNG, "
                        "or WebP image."
                    ),
                )

            image_bytes = await upload.read(MAX_FACE_UPLOAD_BYTES + 1)

            if len(image_bytes) > MAX_FACE_UPLOAD_BYTES:
                raise HTTPException(
                    status_code=413,
                    detail=f"The {pose} image must be no larger than 8 MB.",
                )

            if not image_bytes:
                raise HTTPException(
                    status_code=422,
                    detail=f"The {pose} image is empty.",
                )

            try:
                vector = await run_in_threadpool(embed_face, image_bytes)
                stored_embeddings[pose] = embedding_to_bytes(vector)

            except ValueError as exc:
                raise HTTPException(
                    status_code=422,
                    detail=f"{pose.capitalize()} capture: {exc}",
                ) from exc

    finally:
        # Close uploaded files, whether processing succeeds or fails.
        for _, upload in captures:
            await upload.close()

    # 4. Save one profile with three embedding samples.
    profile = models.FaceProfile(
        user_id=user_id,
        display_name=display_name.strip(),
        relationship_label=(
            relationship_label.strip()
            if relationship_label and relationship_label.strip()
            else None
        ),
        consent_given=True,
        is_active=True,
    )

    try:
        db.add(profile)
        db.flush()

        for pose in ("straight", "left", "right"):
            sample = models.FaceSample(
                profile_id=profile.id,
                embedding=stored_embeddings[pose],
                source=source,
            )
            db.add(sample)

        db.commit()
        db.refresh(profile)

    except SQLAlchemyError as exc:
        db.rollback()
        raise HTTPException(
            status_code=500,
            detail="Could not save enrollment. No success was recorded.",
        ) from exc

    # 5. Return confirmation without returning any biometric embeddings.
    return {
        "message": "Three-pose face enrollment completed.",
        "profile_id": profile.id,
        "user_id": profile.user_id,
        "display_name": profile.display_name,
        "samples_saved": 3,
        "poses_processed": ["straight", "left", "right"],
        "original_photos_saved": False,
        "identity_verified": False,
    }



@app.get("/face-profiles/{user_id}")
def list_face_profiles(
    user_id: int,
    db: Session = Depends(get_db),
    current: models.User = Depends(current_user),
):
    """List profiles for a Sentinel user without returning embeddings."""
    require_self(user_id, current)

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
    caller: models.User | None = Depends(optional_user),
    x_api_key: str | None = Header(default=None),
):
    """Compare a face with enrolled profiles using prototype rules."""
    if not pipeline_ok(x_api_key):
        require_self(user_id, caller)

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
        raise HTTPException(
            status_code=404,
            detail="User not found.",
        )

    image_bytes = await image.read(MAX_FACE_UPLOAD_BYTES + 1)
    await image.close()

    if not image_bytes:
        raise HTTPException(
            status_code=400,
            detail="The uploaded image is empty.",
        )

    if len(image_bytes) > MAX_FACE_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail="Image must be no larger than 8 MB.",
        )

    started = time.perf_counter()
    try:
        query_vector = await run_in_threadpool(embed_face, image_bytes)
    except ValueError as exc:
        raise HTTPException(
            status_code=422,
            detail=str(exc),
        ) from exc
    embedding_ms = round((time.perf_counter() - started) * 1000)

    outcome = match_vector(load_reference_index(db, user_id), query_vector)
    verified = outcome["verified"]
    matched_profile = outcome["matched_profile"]
    best_similarity = outcome["best_similarity"]
    reason = outcome["reason"]
    candidates = outcome["candidates"]

    return {
        "message": (
            "Prototype face comparison completed. "
            "A positive result means the configured similarity "
            "rules passed; it does not guarantee identity."
        ),
        "user_id": user_id,
        "identity_verified": verified,
        "verification_reason": reason,
        "matched_profile": matched_profile,
        "best_similarity": best_similarity,
        "candidates": candidates,
        "threshold": FACE_VERIFICATION_THRESHOLD,
        "minimum_score_gap": FACE_MINIMUM_SCORE_GAP,
        "timing_ms": {
            "embedding": embedding_ms,
            "total": round((time.perf_counter() - started) * 1000),
        },
    }



@app.post("/face-profiles/{user_id}/verify-frame")
async def verify_frame(
    user_id: int,
    image: UploadFile = File(...),
    db: Session = Depends(get_db),
    caller: models.User | None = Depends(optional_user),
    x_api_key: str | None = Header(default=None),
):
    """Find EVERY face in a frame and say, for each one, who it is or that it is unknown."""
    if not pipeline_ok(x_api_key):
        require_self(user_id, caller)

    if image.content_type not in {"image/jpeg", "image/png", "image/webp"}:
        raise HTTPException(status_code=415, detail="Use a JPEG, PNG, or WebP image.")
    if db.get(models.User, user_id) is None:
        raise HTTPException(status_code=404, detail="User not found.")

    image_bytes = await image.read(MAX_FACE_UPLOAD_BYTES + 1)
    await image.close()
    if not image_bytes:
        raise HTTPException(status_code=400, detail="The uploaded image is empty.")
    if len(image_bytes) > MAX_FACE_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Image must be no larger than 8 MB.")

    started = time.perf_counter()
    try:
        width, height, found = await run_in_threadpool(detect_faces, image_bytes)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    index = load_reference_index(db, user_id)
    faces = []
    for face in found:
        outcome = match_vector(index, face["vector"])
        faces.append({
            "bbox": face["bbox"],
            "det_score": round(face["det_score"], 3),
            "identity_verified": outcome["verified"],
            "verification_reason": outcome["reason"],
            "matched_profile": outcome["matched_profile"],
            "best_similarity": outcome["best_similarity"],
            "_vector": face["vector"],
        })

    # One person cannot be in the frame twice: if two faces claim the same profile,
    # the closer match keeps the name and the other is shown as unknown.
    strongest = {}
    for i, face in enumerate(faces):
        if face["identity_verified"]:
            pid = face["matched_profile"]["profile_id"]
            if pid not in strongest or face["best_similarity"] > faces[strongest[pid]]["best_similarity"]:
                strongest[pid] = i
    for i, face in enumerate(faces):
        if face["identity_verified"] and strongest[face["matched_profile"]["profile_id"]] != i:
            face["identity_verified"] = False
            face["matched_profile"] = None
            face["verification_reason"] = "duplicate_profile_in_frame"

    # Unrecognised faces carry their embedding so the live camera can tell strangers apart
    # (the browser keeps it in memory only for the current session).
    for face in faces:
        vector = face.pop("_vector")
        if not face["identity_verified"]:
            face["embedding"] = [round(float(x), 4) for x in vector]

    return {
        "message": (
            "Prototype face comparison completed. "
            "A positive result means the configured similarity "
            "rules passed; it does not guarantee identity."
        ),
        "user_id": user_id,
        "image_width": width,
        "image_height": height,
        "faces": faces,
        "threshold": FACE_VERIFICATION_THRESHOLD,
        "minimum_score_gap": FACE_MINIMUM_SCORE_GAP,
        "timing_ms": round((time.perf_counter() - started) * 1000),
    }


@app.delete("/face-profiles/{user_id}/{profile_id}")
def delete_face_profile(
    user_id: int,
    profile_id: int,
    db: Session = Depends(get_db),
    current: models.User = Depends(current_user),
):
    """Delete a profile and its samples from the database."""
    require_self(user_id, current)

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