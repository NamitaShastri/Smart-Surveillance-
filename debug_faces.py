
from pathlib import Path
import cv2
from insightface.app import FaceAnalysis

IMAGE_PATH = Path("known_faces/Namita/img3N.jpeg")

app = FaceAnalysis(
    name="buffalo_l",
    providers=["CPUExecutionProvider"]
)
app.prepare(
    ctx_id=0,
    det_size=(640, 640),
    det_thresh=0.6
)

image = cv2.imread(str(IMAGE_PATH))

if image is None:
    raise FileNotFoundError(f"Cannot read image: {IMAGE_PATH}")

faces = app.get(image)
print(f"Detected faces: {len(faces)}")

for i, face in enumerate(faces, start=1):
    x1, y1, x2, y2 = map(int, face.bbox)
    score = float(face.det_score)

    print(
        f"Face {i}: box=({x1}, {y1}, {x2}, {y2}), "
        f"detection_score={score:.3f}"
    )

    cv2.rectangle(image, (x1, y1), (x2, y2), (0, 255, 0), 2)
    cv2.putText(
        image,
        f"Face {i}: {score:.2f}",
        (x1, max(y1 - 10, 20)),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.6,
        (0, 255, 0),
        2
    )

output_path = Path("debug_img3.jpeg")
cv2.imwrite(str(output_path), image)
print(f"Annotated image saved to: {output_path.resolve()}")
