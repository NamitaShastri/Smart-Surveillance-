"""Turn a browser webcam recording (.webm) into hourly CCTV-style .mp4 files (needs ffmpeg)."""
import re
import shutil
import subprocess
import uuid
from datetime import datetime, timedelta
from pathlib import Path

FPS = 15


def find_ffmpeg():
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError:
        return None


def _run(command):
    return subprocess.run(command, capture_output=True, text=True)


def probe(ffmpeg, path):
    """Return (duration_seconds, width, height) of a video file."""
    info = _run([ffmpeg, "-hide_banner", "-i", str(path)]).stderr
    duration = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", info)
    size = re.search(r"Video:.*?,\s*(\d{2,5})x(\d{2,5})", info)
    seconds = int(duration[1]) * 3600 + int(duration[2]) * 60 + float(duration[3]) if duration else 0.0
    return seconds, int(size[1]) if size else 0, int(size[2]) if size else 0


def _encode(ffmpeg, args_in, dst, extra_filters=None):
    vf = f"fps={FPS},scale=trunc(iw/2)*2:trunc(ih/2)*2"
    command = [
        ffmpeg, "-y", "-loglevel", "error", *args_in,
        "-vf", vf, "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
        "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", "-f", "mp4", str(dst),
    ]
    result = _run(command)
    if result.returncode != 0 or not Path(dst).is_file():
        raise ValueError(f"ffmpeg failed: {result.stderr.strip()[-300:]}")


def _merge_into_slot(ffmpeg, segment, target):
    """Append `segment` to the hour's file (one continuous recording per hour)."""
    if not target.exists():
        segment.replace(target)
        return
    _, width, height = probe(ffmpeg, target)
    part = target.with_name(f".merge_{uuid.uuid4().hex}.mp4.part")
    fit = (
        f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
        f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps={FPS}"
    )
    command = [
        ffmpeg, "-y", "-loglevel", "error", "-i", str(target), "-i", str(segment),
        "-filter_complex", f"[0:v]{fit}[a];[1:v]{fit}[b];[a][b]concat=n=2:v=1:a=0[v]",
        "-map", "[v]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
        "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-f", "mp4", str(part),
    ]
    try:
        result = _run(command)
        if result.returncode != 0 or not part.is_file():
            raise ValueError(f"ffmpeg merge failed: {result.stderr.strip()[-300:]}")
        part.replace(target)
    finally:
        part.unlink(missing_ok=True)
        segment.unlink(missing_ok=True)


def save_live_recording(upload, folder, ended_at):
    """Convert an uploaded webcam clip and file it under the hour(s) it was recorded in.

    A clip that crosses an hour boundary is split, like a real recorder rolling over.
    Returns the list of hour files that were written.
    """
    ffmpeg = find_ffmpeg()
    if ffmpeg is None:
        raise RuntimeError("ffmpeg not found. Install ffmpeg, or run: pip install imageio-ffmpeg")

    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    token = uuid.uuid4().hex
    full = folder / f".full_{token}.mp4.part"
    written, leftovers = [], [full]
    try:
        _encode(ffmpeg, ["-i", str(upload)], full)
        duration, _, _ = probe(ffmpeg, full)
        if duration < 1:
            raise ValueError("The recording is too short (under 1 second).")

        cursor = ended_at - timedelta(seconds=duration)
        offset, index = 0.0, 0
        while offset < duration - 0.05:
            boundary = cursor.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
            length = min(duration - offset, (boundary - cursor).total_seconds())
            segment = folder / f".seg_{token}_{index}.mp4.part"
            leftovers.append(segment)
            if offset == 0 and length >= duration - 0.05:
                shutil.copyfile(full, segment)
            else:
                _encode(ffmpeg, ["-ss", f"{offset:.3f}", "-i", str(full), "-t", f"{length:.3f}"], segment)
            target = folder / f"{cursor:%Y-%m-%d_%H}h.mp4"
            _merge_into_slot(ffmpeg, segment, target)
            written.append(target)
            offset += length
            cursor += timedelta(seconds=length)
            index += 1
        return written
    finally:
        for path in leftovers:
            path.unlink(missing_ok=True)