"""
mabu_media.py — image metadata (EXIF) extraction.

Purely local processing of image bytes you upload — nothing is sent
anywhere. Useful for OSINT work on images you have legitimate access to
(e.g. checking for embedded GPS coordinates, camera/device info, or
timestamps before further analysis).
"""

import base64
import io

from PIL import Image
from PIL.ExifTags import TAGS, GPSTAGS


def _convert_to_degrees(value):
    d, m, s = value
    return float(d) + float(m) / 60.0 + float(s) / 3600.0


def _extract_gps(gps_info: dict) -> dict | None:
    if not gps_info:
        return None

    gps_data = {}
    for key, val in gps_info.items():
        tag = GPSTAGS.get(key, key)
        gps_data[tag] = val

    if "GPSLatitude" not in gps_data or "GPSLongitude" not in gps_data:
        return None

    try:
        lat = _convert_to_degrees(gps_data["GPSLatitude"])
        if gps_data.get("GPSLatitudeRef") == "S":
            lat = -lat
        lon = _convert_to_degrees(gps_data["GPSLongitude"])
        if gps_data.get("GPSLongitudeRef") == "W":
            lon = -lon
        return {
            "latitude": round(lat, 6),
            "longitude": round(lon, 6),
            "maps_url": f"https://www.openstreetmap.org/?mlat={lat}&mlon={lon}&zoom=16",
        }
    except (KeyError, TypeError, ZeroDivisionError):
        return None


def extract_metadata(image_bytes: bytes) -> dict:
    try:
        img = Image.open(io.BytesIO(image_bytes))
    except Exception as e:
        return {"error": f"Could not read image: {e}"}

    result = {
        "format": img.format,
        "mode": img.mode,
        "size": {"width": img.width, "height": img.height},
        "exif": {},
        "gps": None,
    }

    try:
        exif_data = img.getexif()
    except Exception:
        exif_data = None

    if exif_data:
        gps_info = None
        for tag_id, value in exif_data.items():
            tag = TAGS.get(tag_id, tag_id)
            if tag == "GPSInfo":
                gps_info = value
                continue
            if isinstance(value, bytes):
                try:
                    value = value.decode("utf-8", errors="replace")
                except Exception:
                    value = repr(value)
            result["exif"][str(tag)] = str(value)

        if gps_info:
            result["gps"] = _extract_gps(gps_info)

    return result


def extract_metadata_from_b64(data_b64: str) -> dict:
    try:
        raw = base64.b64decode(data_b64)
    except Exception as e:
        return {"error": f"Invalid base64 data: {e}"}
    return extract_metadata(raw)
