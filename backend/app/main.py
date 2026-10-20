
from fastapi import FastAPI, Depends, HTTPException
from sqlalchemy.orm import Session

from .database import Base, engine, SessionLocal
from . import models, schemas


from datetime import datetime, timezone
from zoneinfo import ZoneInfo



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
