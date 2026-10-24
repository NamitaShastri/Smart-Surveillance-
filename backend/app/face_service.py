from pathlib import Path

import cv2
import numpy as np

# Reuse the existing InsightFace model and helpers.
# Run Uvicorn from the project root, as in the instructions.
from face_recognition import (
    app as insightface_app,
    cosine_similarity,
)


def _decode_image(image_bytes: bytes) -> np.ndarray:
    """Validate and decode an uploaded/captured image."""
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

    return image


def embedding_from_bytes(image_bytes: bytes) -> np.ndarray:
    """Decode an uploaded/captured image and extract exactly one face."""
    image = _decode_image(image_bytes)

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


def faces_from_bytes(
    image_bytes: bytes,
    min_face_px: int = 40,
    max_faces: int = 10,
) -> tuple[int, int, list[dict]]:
    """Find every usable face in a frame (for the live camera).

    Returns (image_width, image_height, faces). Zero faces is a normal result.
    Each face has a pixel bbox [x1, y1, x2, y2], a detection score and an embedding.
    Faces smaller than `min_face_px` are ignored: too small to compare reliably.
    """
    image = _decode_image(image_bytes)
    height, width = image.shape[:2]

    found = []
    for face in insightface_app.get(image):
        x1, y1, x2, y2 = (int(round(v)) for v in face.bbox)
        x1, y1 = max(0, x1), max(0, y1)
        x2, y2 = min(width, x2), min(height, y2)
        if x2 - x1 < min_face_px or y2 - y1 < min_face_px:
            continue

        vector = np.asarray(face.normed_embedding, dtype=np.float32)
        if vector.ndim != 1 or not np.isfinite(vector).all():
            continue

        found.append({
            "bbox": [x1, y1, x2, y2],
            "det_score": float(face.det_score),
            "vector": vector,
        })

    found.sort(
        key=lambda f: (f["bbox"][2] - f["bbox"][0]) * (f["bbox"][3] - f["bbox"][1]),
        reverse=True,
    )
    return width, height, found[:max_faces]


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