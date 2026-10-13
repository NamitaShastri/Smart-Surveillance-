
from ultralytics import YOLO

# Load the pretrained YOLO model
model = YOLO("yolo11n.pt")

video_path = "test_video.mp4"

# Detect and track people across frames
results = model.track(
    source=video_path,
    tracker="bytetrack.yaml",
    classes=[0],
    conf=0.25,
    save=True,
    show=False,
    persist=True,
    verbose=False
)

print("Phase 2: Person tracking finished!")
print("Check the runs/detect/track folder for your output video.")
