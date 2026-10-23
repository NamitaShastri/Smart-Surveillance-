"""Convert YOLO's .avi recordings to browser-playable H.264 .mp4.

Used automatically by main.py after each run. To convert existing files:
    python convert_recordings.py 1        (camera id; converts runs/detect/camera_1)
"""
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

RUNS_DIR = Path(__file__).resolve().parent / "runs" / "detect"


def find_ffmpeg():
    """Use ffmpeg from PATH, or the copy bundled with `pip install imageio-ffmpeg`."""
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError:
        return None


def stamp_hourly_recording(folder, source_stem, when=None):
    """Name YOLO's output after the hour it belongs to (e.g. 2026-10-22_16h).

    Like a real CCTV recorder, each hour holds ONE recording: a newer run in the same
    hour replaces the older one once its conversion succeeds. The staging file uses the
    .raw extension, so the API never lists a half-finished recording.
    """
    folder = Path(folder)
    when = when or datetime.now()
    for produced in sorted(folder.glob(f"{source_stem}.*")):
        if produced.suffix.lower() in {".avi", ".mp4", ".mkv", ".mov"}:
            staged = folder / f"{when:%Y-%m-%d_%H}h.raw"
            produced.replace(staged)
            return staged
    return None


def convert_recordings_to_mp4(folder):
    """Convert every .avi / .raw in `folder` to .mp4, deleting the source only if that worked."""
    folder = Path(folder)
    avis = sorted([*folder.glob("*.avi"), *folder.glob("*.raw")])
    if not avis:
        return

    ffmpeg = find_ffmpeg()
    if ffmpeg is None:
        print(
            "ffmpeg not found, so recordings stay as .avi (most browsers can't play them).\n"
            "Fix: install ffmpeg, or run  pip install imageio-ffmpeg  in your venv."
        )
        return

    for avi in avis:  # (the variable name is historical: it may be .avi or .raw)
        mp4 = avi.with_suffix(".mp4")
        part = avi.with_name(avi.stem + ".mp4.part")  # never listed by the API
        command = [
            ffmpeg, "-y", "-loglevel", "error", "-i", str(avi),
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
            "-pix_fmt", "yuv420p", "-movflags", "+faststart",
            "-f", "mp4", str(part),
        ]
        print(f"Converting {avi.name} -> {mp4.name} ...")
        result = subprocess.run(command, capture_output=True, text=True)

        if result.returncode == 0 and part.is_file() and part.stat().st_size > 0:
            part.replace(mp4)
            try:
                avi.unlink()
            except OSError as error:
                print(f"Converted, but could not delete {avi.name}: {error}")
            print(f"Saved {mp4.name}")
        else:
            part.unlink(missing_ok=True)
            print(f"Conversion failed; kept {avi.name}.\n{result.stderr.strip()[-400:]}")


if __name__ == "__main__":
    camera = sys.argv[1] if len(sys.argv) > 1 else "1"
    convert_recordings_to_mp4(RUNS_DIR / f"camera_{camera}")