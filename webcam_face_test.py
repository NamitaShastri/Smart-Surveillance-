
import cv2
from collections import deque
from face_recognition import (
    app,
    load_reference_embeddings,
    cosine_similarity,
)


def main():
    print("Loading enrolled face references...")
    references = load_reference_embeddings()

    if not references:
        print("No usable reference photos found.")
        return

    print("\nStarting webcam...")
    camera = cv2.VideoCapture(0)

    if not camera.isOpened():
        print("Could not open webcam. Check camera permissions.")
        return

    # Keep the latest 30 valid readings for diagnostics.
    score_history = deque(maxlen=30)

    print("Webcam ready! Look at the camera.")
    print("Press Q in the webcam window to quit.")

    try:
        while True:
            success, frame = camera.read()

            if not success:
                print("Could not read webcam frame.")
                break

            # InsightFace expects the OpenCV BGR frame.
            faces = app.get(frame)

            if len(faces) == 0:
                # Do not display a score from an earlier frame.
                cv2.putText(
                    frame,
                    "NO FACE DETECTED",
                    (10, 35),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.8,
                    (0, 0, 255),
                    2,
                )
                cv2.putText(
                    frame,
                    "Identity: UNVERIFIED",
                    (10, 70),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.65,
                    (0, 0, 255),
                    2,
                )

            else:
                # Evaluate each currently detected face separately.
                for index, face in enumerate(faces):
                    x1, y1, x2, y2 = map(
                        int, face.bbox
                    )

                    embedding = face.normed_embedding

                    scores = [
                        (
                            name,
                            cosine_similarity(
                                embedding,
                                reference_embedding,
                            ),
                        )
                        for name, reference_embedding in references
                    ]

                    scores.sort(
                        key=lambda item: item[1],
                        reverse=True,
                    )

                    best_name, best_score = scores[0]
                    score_history.append(best_score)

                    # Diagnostic only: never declare an identity match.
                    label = f"Score: {best_score:.3f}"

                    cv2.rectangle(
                        frame,
                        (x1, y1),
                        (x2, y2),
                        (0, 200, 0),
                        2,
                    )

                    cv2.putText(
                        frame,
                        label,
                        (x1, max(y1 - 10, 25)),
                        cv2.FONT_HERSHEY_SIMPLEX,
                        0.65,
                        (0, 200, 0),
                        2,
                    )

                    cv2.putText(
                        frame,
                        f"Face {index + 1}: UNVERIFIED",
                        (10, 35 + index * 30),
                        cv2.FONT_HERSHEY_SIMPLEX,
                        0.6,
                        (0, 0, 255),
                        2,
                    )

                    cv2.putText(
                        frame,
                        f"Best reference: {best_name}",
                        (10, 130 + index * 30),
                        cv2.FONT_HERSHEY_SIMPLEX,
                        0.55,
                        (255, 255, 255),
                        2,
                    )

                cv2.putText(
                    frame,
                    "Similarity is NOT identity probability",
                    (10, frame.shape[0] - 20),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.55,
                    (0, 255, 255),
                    2,
                )

            # Show rolling statistics only when a face is detected now.
            if len(faces) > 0 and score_history:
                recent_min = min(score_history)
                recent_max = max(score_history)

                cv2.putText(
                    frame,
                    f"Recent range: {recent_min:.3f}-{recent_max:.3f}",
                    (10, 95),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.55,
                    (255, 255, 255),
                    2,
                )

            cv2.imshow("Live Face Recognition Diagnostics", frame)

            if cv2.waitKey(1) & 0xFF == ord("q"):
                break

    finally:
        camera.release()
        cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
