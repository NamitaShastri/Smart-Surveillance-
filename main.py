
from ultralytics import YOLO
import requests
import hashlib
from pathlib import Path

# ---------------- CONFIGURATION ----------------

MODEL_PATH = "yolo11n.pt"
VIDEO_PATH = "test_video.mp4"
CAMERA_ID = 1

API_URL = f"http://127.0.0.1:8000/cameras/{CAMERA_ID}/events"


# ---------------- VIDEO FINGERPRINT ----------------

def get_video_fingerprint(video_path):
    """Generate a stable fingerprint for a video file."""
    sha256 = hashlib.sha256()

    with Path(video_path).open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            sha256.update(chunk)

    return sha256.hexdigest()


video_fingerprint = get_video_fingerprint(VIDEO_PATH)
print("Video fingerprint:", video_fingerprint)


# ---------------- LOAD MODEL ----------------

model = YOLO(MODEL_PATH)

# Track IDs already processed during this run.
seen_track_ids = set()

print("Starting person detection and tracking...")


# ---------------- DETECT AND TRACK ----------------

results = model.track(
    source=VIDEO_PATH,
    tracker="bytetrack.yaml",
    classes=[0],
    conf=0.25,
    save=True,
    show=False,
    persist=True,
    verbose=False,
    stream=True,
)

events_created = 0
duplicates_skipped = 0
failed_events = 0

for result in results:
    if result.boxes is None or result.boxes.id is None:
        continue

    track_ids = result.boxes.id.int().cpu().tolist()
    classes = result.boxes.cls.int().cpu().tolist()
    confidences = result.boxes.conf.cpu().tolist()

    for track_id, class_id, confidence in zip(
        track_ids, classes, confidences
    ):
        # Only report people.
        if class_id != 0:
            continue

        # Report only the first detection of each track ID per run.
        if track_id in seen_track_ids:
            continue

        seen_track_ids.add(track_id)

        payload = {
            "event_key": (
                f"video:{video_fingerprint}:"
                f"camera:{CAMERA_ID}:"
                f"track:{track_id}"
            ),
            "event_type": "person_detected",
            "person_label": "Unknown person",
            "confidence": round(float(confidence), 4),
            "tracking_id": str(track_id),
            "details": (
                f"Person detected in {VIDEO_PATH}; "
                f"ByteTrack ID: {track_id}"
            ),
        }

        try:
            response = requests.post(
                API_URL,
                json=payload,
                timeout=5,
            )
            response.raise_for_status()
            saved_event = response.json()

            if response.status_code == 201:
                events_created += 1
                print(
                    f"New event created: ID={saved_event['id']} | "
                    f"Track={track_id} | "
                    f"Time={saved_event['timestamp']}"
                )

            elif response.status_code == 200:
                duplicates_skipped += 1
                print(
                    f"Duplicate event skipped: "
                    f"ID={saved_event['id']} | Track={track_id}"
                )

            else:
                print(f"Unexpected status: {response.status_code}")

        except requests.RequestException as error:
            failed_events += 1
            print(
                f"Could not save event for track {track_id}: {error}"
            )

print("\nPerson tracking finished!")
print(f"New events created: {events_created}")
print(f"Duplicates skipped: {duplicates_skipped}")
print(f"Failed events: {failed_events}")
print("Check the runs/detect/track folder for your output video.")
