
from pydantic import BaseModel, ConfigDict


class UserCreate(BaseModel):
    name: str
    email: str


class UserResponse(BaseModel):
    id: int
    name: str
    email: str

    model_config = ConfigDict(from_attributes=True)


class LocationCreate(BaseModel):
    name: str
    address: str | None = None


class LocationResponse(LocationCreate):
    id: int
    user_id: int

    model_config = ConfigDict(from_attributes=True)



class CameraCreate(BaseModel):
    name: str
    source: str | None = None


class CameraResponse(CameraCreate):
    id: int
    location_id: int
    status: str

    model_config = ConfigDict(from_attributes=True)




from datetime import datetime, timezone
from zoneinfo import ZoneInfo
from pydantic import BaseModel, ConfigDict, Field, field_serializer

IST = ZoneInfo("Asia/Kolkata")



class DetectionEventCreate(BaseModel):
    event_type: str = "person_detected"
    person_label: str = "Unknown person"
    confidence: float | None = Field(default=None, ge=0, le=1)
    tracking_id: str | None = None
    details: str | None = None
    timestamp: datetime | None = None
    event_key: str | None = None


class DetectionEventResponse(DetectionEventCreate):
    id: int
    camera_id: int
    timestamp: datetime

    model_config = ConfigDict(from_attributes=True)

    
    @field_serializer("timestamp")
    def serialize_timestamp(self, value: datetime) -> datetime:
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)

        return value.astimezone(IST)

