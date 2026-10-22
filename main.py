from ultralytics import YOLO
import requests
import hashlib
import os
import cv2

from pathlib import Path
from insightface.app import FaceAnalysis

from convert_recordings import convert_recordings_to_mp4

# ---------------- CONFIGURATION ----------------

MODEL_PATH = "yolo11n.pt"
print("Loading face detector...")

face_app = FaceAnalysis(
    name="buffalo_l",
    providers=["CPUExecutionProvider"]
)
face_app.prepare(ctx_id=-1, det_size=(640, 640))

print("Face detector ready!")
VIDEO_PATH = "namita_test.mp4"

CAMERA_ID = 1
USER_ID = 1

API_BASE = "http://127.0.0.1:8000"
API_URL = f"{API_BASE}/cameras/{CAMERA_ID}/events"
VERIFY_URL = f"{API_BASE}/face-profiles/{USER_ID}/verify"

# Shared secret for the backend (set SENTINEL_PIPELINE_KEY in both places).
PIPELINE_KEY = os.getenv("SENTINEL_PIPELINE_KEY")
API_HEADERS = {"X-API-Key": PIPELINE_KEY} if PIPELINE_KEY else {}

# Recordings go to runs/detect/camera_<id>/ so the dashboard can filter by camera.
RUNS_DIR = Path(__file__).resolve().parent / "runs" / "detect"

# Provisional demo threshold only; not a validated identity threshold.
FACE_SIMILARITY_THRESHOLD = 0.60


# ---------------- VIDEO FINGERPRINT ----------------

def get_video_fingerprint(video_path):
    """Generate a stable fingerprint for a video file."""
    sha256 = hashlib.sha256()

    with Path(video_path).open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            sha256.update(chunk)

    return sha256.hexdigest()


# ---------------- FACE CANDIDATE LOOKUP ----------------


def recognize_person(frame, person_box, detected_faces):
    """
    Compare a detected face against enrolled profiles.
    Only return a person's name when the backend explicitly
    confirms identity_verified=True.
    """
    x1, y1, x2, y2 = map(int, person_box)
    matching_faces = []

    for face in detected_faces:
        fx1, fy1, fx2, fy2 = face.bbox.astype(int)

        center_x = (fx1 + fx2) // 2
        center_y = (fy1 + fy2) // 2

        if x1 <= center_x <= x2 and y1 <= center_y <= y2:
            matching_faces.append((face, fx1, fy1, fx2, fy2))

    if not matching_faces:
        return "Unknown person", None

    # Select the largest face inside the tracked person box.
    face, fx1, fy1, fx2, fy2 = max(
        matching_faces,
        key=lambda item: max(0, item[3] - item[1])
        * max(0, item[4] - item[2]),
    )

    frame_height, frame_width = frame.shape[:2]
    face_width = fx2 - fx1
    face_height = fy2 - fy1

    if face_width < 40 or face_height < 40:
        print(f"Face too small: {face_width}x{face_height}")
        return "Unknown person", None

    # Add padding around the detected face.
    pad_x = int(face_width * 0.35)
    pad_y = int(face_height * 0.35)

    crop_x1 = max(0, fx1 - pad_x)
    crop_y1 = max(0, fy1 - pad_y)
    crop_x2 = min(frame_width, fx2 + pad_x)
    crop_y2 = min(frame_height, fy2 + pad_y)

    face_crop = frame[crop_y1:crop_y2, crop_x1:crop_x2]

    if face_crop.size == 0:
        return "Unknown person", None

    try:
        success, encoded_image = cv2.imencode(".jpg", face_crop)

        if not success:
            return "Unknown person", None

        response = requests.post(
            VERIFY_URL,
            files={
                "image": (
                    "face.jpg",
                    encoded_image.tobytes(),
                    "image/jpeg",
                )
            },
            headers=API_HEADERS,
            timeout=15,
        )

        print("Verification status:", response.status_code)

        if response.status_code >= 400:
            print("Face API error:", response.text)
            return "Unknown person", None

        data = response.json()
        print("Verification response:", data)

        similarity = data.get("best_similarity")

        # Do not treat a candidate as a confirmed identity.
        if not data.get("identity_verified", False):
            print(
                "Identity not verified:",
                data.get("verification_reason", "unknown_reason"),
            )
            return "Unknown person", similarity

        matched_profile = data.get("matched_profile")

        if (
            not isinstance(matched_profile, dict)
            or not matched_profile.get("display_name")
        ):
            print("Verification response has no matched profile.")
            return "Unknown person", similarity

        print(
            f"Verified profile: {matched_profile['display_name']} | "
            f"Similarity: {similarity}"
        )

        return matched_profile["display_name"], similarity

    except (
        requests.RequestException,
        ValueError,
        KeyError,
        TypeError,
    ) as error:
        print("Face matching unavailable:", error)
        return "Unknown person", None

# ---------------- START PIPELINE ----------------

video_fingerprint = get_video_fingerprint(VIDEO_PATH)
print("Video fingerprint:", video_fingerprint)

model = YOLO(MODEL_PATH)

# Track IDs already processed during this run.
seen_track_ids = set()

events_created = 0
duplicates_skipped = 0
failed_events = 0

print("Starting person detection, tracking, and face matching...")

results = model.track(
    source=VIDEO_PATH,
    tracker="bytetrack.yaml",
    classes=[0],
    conf=0.25,
    save=True,
    project=str(RUNS_DIR),
    name=f"camera_{CAMERA_ID}",
    exist_ok=True,
    show=False,
    persist=True,
    verbose=False,
    stream=True,
)

# ---------------- DETECT, RECOGNIZE, SAVE ----------------

for result in results:
    if result.boxes is None or result.boxes.id is None:
        continue

    track_ids = result.boxes.id.int().cpu().tolist()
    classes = result.boxes.cls.int().cpu().tolist()
    confidences = result.boxes.conf.cpu().tolist()
    coordinates = result.boxes.xyxy.int().cpu().tolist()

    frame = result.orig_img
    frame_height, frame_width = frame.shape[:2]
    # Detect faces once per frame, not once per person.
    detected_faces = face_app.get(frame)
    for track_id, class_id, confidence, box in zip(
        track_ids, classes, confidences, coordinates
    ):
        if class_id != 0:
            continue

        # Report only the first detection of each track ID per run.
        if track_id in seen_track_ids:
            continue

        seen_track_ids.add(track_id)

        x1, y1, x2, y2 = box

        # Keep crop coordinates within the frame.
        x1 = max(0, min(x1, frame_width))
        x2 = max(0, min(x2, frame_width))
        y1 = max(0, min(y1, frame_height))
        y2 = max(0, min(y2, frame_height))

        person_label, face_similarity = recognize_person(
        frame,
        (x1, y1, x2, y2),
        detected_faces,
)

        print(
    f"Track={track_id} | "
    f"Face candidates={len(detected_faces)} | "
    f"Person={person_label} | "
    f"Similarity={face_similarity}"
)
        if face_similarity is None:
            match_details = "Face match unavailable or no usable face found."
        else:
            match_details = (
                f"Candidate similarity: {face_similarity:.4f}; "
                f"threshold: {FACE_SIMILARITY_THRESHOLD:.2f} (demo only)."
            )

        payload = {
            "event_key": (
                f"video:{video_fingerprint}:"
                f"camera:{CAMERA_ID}:"
                f"track:{track_id}"
            ),
            "event_type": "person_detected",
            "person_label": person_label,
            "confidence": round(float(confidence), 4),
            "tracking_id": str(track_id),
            "details": (
                f"Person detected in {VIDEO_PATH}; "
                f"ByteTrack ID: {track_id}. "
                f"{match_details}"
            ),
        }

        try:
            response = requests.post(
                API_URL,
                json=payload,
                headers=API_HEADERS,
                timeout=5,
            )
            response.raise_for_status()
            saved_event = response.json()

            if response.status_code == 201:
                events_created += 1
                print(
                    f"New event: ID={saved_event['id']} | "
                    f"Track={track_id} | "
                    f"Person={person_label} | "
                    f"Time={saved_event['timestamp']}"
                )

            elif response.status_code == 200:
                duplicates_skipped += 1
                print(
                    f"Duplicate event skipped: "
                    f"ID={saved_event['id']} | Track={track_id}"
                )

        except requests.RequestException as error:
            failed_events += 1
            print(
                f"Could not save event for track {track_id}: {error}"
            )

# Make the saved video playable in the browser (.avi -> .mp4).
convert_recordings_to_mp4(RUNS_DIR / f"camera_{CAMERA_ID}")

print("\nPerson tracking and recognition finished!")
print(f"New events created: {events_created}")
print(f"Duplicates skipped: {duplicates_skipped}")
print(f"Failed events: {failed_events}")
print(f"Check {RUNS_DIR / f'camera_{CAMERA_ID}'} for your output video.")