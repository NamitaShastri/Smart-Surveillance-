
from pathlib import Path

import cv2
import numpy as np

# Reuse the existing InsightFace model and helpers.
# Run Uvicorn from the project root, as in the instructions.
from face_recognition import (
    app as insightface_app,
    cosine_similarity,
)


def embedding_from_bytes(image_bytes: bytes) -> np.ndarray:
    """Decode an uploaded/captured image and extract exactly one face."""
    if not image_bytes:
        raise ValueError("The image is empty.")

    # Reject excessively large uploads before decoding.
    if len(image_bytes) > 8 * 1024 * 1024:
        raise ValueError("Image must be no larger than 8 MB.")

    encoded = np.frombuffer(image_bytes, dtype=np.uint8)
    image = cv2.imdecode(encoded, cv2.IMREAD_COLOR)

    if image is None:
        raise ValueError("The uploaded file is not a valid image.")

    height, width = image.shape[:2]
    if width < 80 or height < 80:
        raise ValueError("Image resolution is too small.")

    faces = insightface_app.get(image)

    if len(faces) == 0:
        raise ValueError("No face detected. Try better lighting.")
    if len(faces) > 1:
        raise ValueError(
            "Multiple faces detected. Please submit an image "
            "containing only the person being enrolled."
        )

    vector = np.asarray(
        faces[0].normed_embedding,
        dtype=np.float32,
    )

    if vector.ndim != 1 or not np.isfinite(vector).all():
        raise ValueError("Could not generate a valid face embedding.")

    return vector


def embedding_to_bytes(vector: np.ndarray) -> bytes:
    """Serialize a normalized embedding for database storage."""
    return np.asarray(vector, dtype=np.float32).tobytes()


def embedding_from_storage(raw: bytes) -> np.ndarray:
    """Restore an embedding from the database."""
    vector = np.frombuffer(raw, dtype=np.float32).copy()

    if vector.ndim != 1 or vector.size == 0:
        raise ValueError("Stored face embedding is invalid.")

    if not np.isfinite(vector).all():
        raise ValueError("Stored face embedding contains invalid values.")

    return vector


def compare_vectors(
    query_vector: np.ndarray,
    reference_vector: np.ndarray,
) -> float:
    """Return a similarity score, not a probability of identity."""
    return cosine_similarity(query_vector, reference_vector)
