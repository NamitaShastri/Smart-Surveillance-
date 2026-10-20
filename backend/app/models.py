from sqlalchemy import (
    Column,
    Integer,
    String,
    ForeignKey,
    Float,
    DateTime,
)
from sqlalchemy.orm import relationship
from datetime import datetime, timezone

from sqlalchemy import LargeBinary, Boolean, Text

from .database import Base



class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(100), nullable=False)
    email = Column(String(255), unique=True, index=True, nullable=False)

    locations = relationship(
        "Location",
        back_populates="owner",
        cascade="all, delete-orphan"
    )


class Location(Base):
    __tablename__ = "locations"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(100), nullable=False)
    address = Column(String(255), nullable=True)

    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)

    owner = relationship("User", back_populates="locations")
    cameras = relationship(
        "Camera",
        back_populates="location",
        cascade="all, delete-orphan"
    )


class Camera(Base):
    __tablename__ = "cameras"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(100), nullable=False)
    source = Column(String(500), nullable=True)
    status = Column(String(30), default="offline", nullable=False)

    location_id = Column(
        Integer,
        ForeignKey("locations.id"),
        nullable=False
    )

    location = relationship("Location", back_populates="cameras")

    
    events = relationship(
        "DetectionEvent",
        back_populates="camera",
        cascade="all, delete-orphan",
    )



class DetectionEvent(Base):
    __tablename__ = "detection_events"

    id = Column(Integer, primary_key=True, index=True)
    event_key = Column(String(200), nullable=True, unique=True)


    camera_id = Column(
        Integer,
        ForeignKey("cameras.id"),
        nullable=False,
        index=True,
    )

    event_type = Column(String(50), nullable=False)
    person_label = Column(
        String(100),
        nullable=False,
        default="Unknown person",
    )

    confidence = Column(Float, nullable=True)
    tracking_id = Column(String(100), nullable=True)
    details = Column(String(500), nullable=True)

    timestamp = Column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
        index=True,
    )

    camera = relationship("Camera", back_populates="events")



class FaceProfile(Base):
    """A person enrolled for recognition within a Sentinel account."""

    __tablename__ = "face_profiles"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(
        Integer,
        ForeignKey("users.id"),
        nullable=False,
        index=True,
    )

    display_name = Column(String(100), nullable=False)
    relationship_label = Column(String(100), nullable=True)

    # Consent must be explicitly supplied at enrollment.
    consent_given = Column(Boolean, nullable=False, default=False)
    is_active = Column(Boolean, nullable=False, default=True)

    created_at = Column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
    )

    owner = relationship("User")
    samples = relationship(
        "FaceSample",
        back_populates="profile",
        cascade="all, delete-orphan",
    )


class FaceSample(Base):
    """One encrypted-at-rest-by-the-host embedding sample is NOT implied.

    Embeddings are stored as binary vectors. Production deployments
    should additionally use protected storage and access controls.
    """

    __tablename__ = "face_samples"

    id = Column(Integer, primary_key=True, index=True)
    profile_id = Column(
        Integer,
        ForeignKey("face_profiles.id"),
        nullable=False,
        index=True,
    )

    embedding = Column(LargeBinary, nullable=False)
    source = Column(String(20), nullable=False)  # upload or live_capture

    created_at = Column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
    )

    profile = relationship("FaceProfile", back_populates="samples")
