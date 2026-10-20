
from pathlib import Path
import cv2
import numpy as np
from insightface.app import FaceAnalysis

# Reference photos of one enrolled person
KNOWN_PERSON_DIR = Path("known_faces") / "Namita"
DISPLAY_NAME = "Namita"

print("Loading InsightFace model...")

app = FaceAnalysis(
    name="buffalo_l",
    providers=["CPUExecutionProvider"]
)
app.prepare(ctx_id=0, det_size=(640, 640), det_thresh=0.6)


print("Face recognition model ready!")



def get_embedding_from_image(image):
    """Extract a normalized embedding when exactly one face is detected."""
    if image is None or not isinstance(image, np.ndarray) or image.size == 0:
        return None

    faces = app.get(image)

    # Enrollment requires exactly one detected face.
    if len(faces) != 1:
        print(f"Expected exactly one face, but detected {len(faces)}.")
        return None

    embedding = faces[0].normed_embedding

    if embedding is None:
        return None

    embedding = np.asarray(embedding, dtype=np.float32)
    norm = np.linalg.norm(embedding)

    if not np.isfinite(embedding).all() or norm == 0:
        return None

    return embedding / norm


def get_embedding(image_path):
    """Read an image from disk and extract its face embedding."""
    image_path = Path(image_path)

    if not image_path.exists():
        print(f"Image not found: {image_path}")
        return None

    image = cv2.imread(str(image_path))

    if image is None:
        print(f"Could not read image: {image_path}")
        return None

    return get_embedding_from_image(image)



def cosine_similarity(embedding1, embedding2):
    """Compare normalized face embeddings."""
    return float(np.dot(embedding1, embedding2))


def load_reference_embeddings():
    """Load usable reference photos for the enrolled person."""
    if not KNOWN_PERSON_DIR.exists():
        print(f"Folder not found: {KNOWN_PERSON_DIR}")
        return []

    extensions = {".jpg", ".jpeg", ".png", ".webp"}
    embeddings = []

    for image_path in sorted(KNOWN_PERSON_DIR.iterdir()):
        if image_path.suffix.lower() not in extensions:
            continue

        embedding = get_embedding(image_path)

        if embedding is not None:
            embeddings.append((image_path.name, embedding))
            print(f"Reference loaded: {image_path.name}")

    return embeddings



if __name__ == "__main__":
    # Load the enrolled reference embeddings
    references = load_reference_embeddings()

    if not references:
        print("No usable reference photos found.")
        raise SystemExit(1)

    print(f"Loaded {len(references)} reference embeddings.")

    # Temporary threshold for testing only.
    # Calibrate this using known-person and unknown-person examples.
    MATCH_THRESHOLD = 0.60

    cap = cv2.VideoCapture(0)

    if not cap.isOpened():
        print("Error: Could not open webcam.")
        raise SystemExit(1)

    print("Webcam opened! Press Q to quit.")

    try:
        while True:
            ret, frame = cap.read()

            if not ret:
                print("Could not read webcam frame.")
                break

            faces = app.get(frame)

            for face in faces:
                x1, y1, x2, y2 = map(int, face.bbox)
                live_embedding = face.normed_embedding

                best_name = "Unknown"
                best_score = -1.0

                # Compare the live face with each reference photo
                for filename, reference_embedding in references:
                    score = cosine_similarity(
                        live_embedding,
                        reference_embedding
                    )

                    if score > best_score:
                        best_score = score
                        best_name = DISPLAY_NAME  # Use the display name for the enrolled person

                # Show a match only if it passes the current threshold
                if best_score >= MATCH_THRESHOLD:
                    label = f"{best_name}: {best_score:.2f}"
                    box_color = (0, 200, 0)
                else:
                    label = f"Unknown: {best_score:.2f}"
                    box_color = (0, 0, 255)

                cv2.rectangle(
                    frame, (x1, y1), (x2, y2), box_color, 2
                )

                cv2.putText(
                    frame,
                    label,
                    (x1, max(y1 - 10, 25)),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.65,
                    box_color,
                    2
                )

            cv2.imshow("Face Recognition", frame)

            if cv2.waitKey(1) & 0xFF == ord("q"):
                break

    finally:
        cap.release()
        cv2.destroyAllWindows()


