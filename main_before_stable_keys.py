
from ultralytics import YOLO
import requests

# ---------------- CONFIGURATION ----------------

MODEL_PATH = "yolo11n.pt"
VIDEO_PATH = "test_video.mp4"

CAMERA_ID = 1
API_URL = f"http://127.0.0.1:8000/cameras/{CAMERA_ID}/events"

# ---------------- LOAD MODEL ----------------

model = YOLO(MODEL_PATH)

# Remember which tracking IDs have already generated events.
seen_track_ids = set()

print("Phase 1: Starting person detection and tracking...")

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

events_sent = 0

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

        # Report only the first detection of each track ID.
        if track_id in seen_track_ids:
            continue

        seen_track_ids.add(track_id)

        payload = {
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

            events_sent += 1
            saved_event = response.json()

            print(
                f"Event saved: ID={saved_event['id']} | "
                f"Track={track_id} | "
                f"Time={saved_event['timestamp']}"
            )

        except requests.RequestException as error:
            print(
                f"Could not save event for track {track_id}: {error}"
            )

print("\nPhase 2: Person tracking finished!")
print(f"Events successfully sent: {events_sent}")
print("Check the runs/detect/track folder for your output video.")
