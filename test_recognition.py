
from pathlib import Path

from face_recognition import (
    get_embedding,
    load_reference_embeddings,
    cosine_similarity,
)

TEST_IMAGE = Path("known_faces") / "test_images" / "test_namita.jpeg"


def main():
    print("Loading enrolled reference photos...")
    references = load_reference_embeddings()

    if not references:
        print("No usable reference photos found.")
        return

    print("\nProcessing new test image...")
    query_embedding = get_embedding(TEST_IMAGE)

    if query_embedding is None:
        print("Could not extract exactly one face.")
        return

    scores = []

    for name, reference_embedding in references:
        score = cosine_similarity(
            query_embedding,
            reference_embedding,
        )
        scores.append((name, score))

    scores.sort(key=lambda item: item[1], reverse=True)

    print("\nSimilarity scores (highest first):")

    for name, score in scores:
        print(f"{name}: {score:.4f}")

    print("\nTest complete.")
    print(
        "These scores are not probabilities. "
        "Do not treat the highest score alone as proof of identity."
    )


if __name__ == "__main__":
    main()
