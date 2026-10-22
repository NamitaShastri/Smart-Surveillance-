from datetime import datetime, timezone
from typing import Literal
from zoneinfo import ZoneInfo

from pydantic import BaseModel, ConfigDict, Field, field_serializer, field_validator

IST = ZoneInfo("Asia/Kolkata")

LocationType = Literal["Home", "Office", "Shop", "Warehouse", "Other"]


def _clean_email(value: str) -> str:
    value = value.strip().lower()
    if "@" not in value or value.startswith("@") or value.endswith("@") or len(value) > 255:
        raise ValueError("Enter a valid email address")
    return value


class UserCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    email: str
    password: str = Field(min_length=8, max_length=128)

    @field_validator("name")
    @classmethod
    def _name(cls, v):
        v = v.strip()
        if not v:
            raise ValueError("Name cannot be empty")
        return v

    _email = field_validator("email")(_clean_email)


class UserUpdate(BaseModel):
    name: str | None = Field(default=None, max_length=100)
    email: str | None = None

    @field_validator("name")
    @classmethod
    def _name(cls, v):
        if v is None:
            return v
        v = v.strip()
        if not v:
            raise ValueError("Name cannot be empty")
        return v

    @field_validator("email")
    @classmethod
    def _email(cls, v):
        return None if v is None else _clean_email(v)


class PasswordChange(BaseModel):
    current_password: str
    new_password: str = Field(min_length=8, max_length=128)


class LoginRequest(BaseModel):
    email: str
    password: str


class UserResponse(BaseModel):
    id: int
    name: str
    email: str

    model_config = ConfigDict(from_attributes=True)


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserResponse


class LocationCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    address: str | None = None
    type: LocationType = "Home"


class LocationResponse(LocationCreate):
    id: int
    user_id: int

    model_config = ConfigDict(from_attributes=True)


class CameraCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    source: str | None = None


class CameraResponse(CameraCreate):
    id: int
    location_id: int
    status: str

    model_config = ConfigDict(from_attributes=True)


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