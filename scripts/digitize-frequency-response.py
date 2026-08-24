#!/usr/bin/env python3
"""Digitize a colored frequency-response trace from a graph image.

The graph geometry, axis ranges, trace colors, and optional profile metadata
are supplied by the caller so this tool can be reused for different sources.
"""

import argparse
import json
import math
from pathlib import Path
from statistics import median

from PIL import Image


def parse_rgb(value):
    try:
        channels = tuple(int(channel.strip()) for channel in value.split(","))
    except ValueError as error:
        raise argparse.ArgumentTypeError("RGB must be written as R,G,B") from error
    if len(channels) != 3 or any(channel < 0 or channel > 255 for channel in channels):
        raise argparse.ArgumentTypeError("RGB channels must be integers from 0 through 255")
    return channels


def frequency_to_x(frequency_hz, axis_min_hz, axis_max_hz, plot_left, plot_right):
    progress = math.log(frequency_hz / axis_min_hz) / math.log(axis_max_hz / axis_min_hz)
    return round(plot_left + progress * (plot_right - plot_left))


def pixel_to_db(y, plot_top, plot_bottom, db_min, db_max):
    progress = (y - plot_top) / (plot_bottom - plot_top)
    return db_max - progress * (db_max - db_min)


def color_distance(left, right):
    return math.sqrt(sum((left[index] - right[index]) ** 2 for index in range(3)))


def find_trace_y(image, x, plot_top, plot_bottom, x_radius, colors, tolerance):
    width, _ = image.size
    start_x = max(0, x - x_radius)
    end_x = min(width - 1, x + x_radius)
    for color in colors:
        candidates = [
            y
            for sample_x in range(start_x, end_x + 1)
            for y in range(plot_top, plot_bottom + 1)
            if color_distance(image.getpixel((sample_x, y)), color) <= tolerance
        ]
        if candidates:
            return median(candidates)
    return None


def interpolate_log(points, frequency_hz):
    if frequency_hz < points[0][0] or frequency_hz > points[-1][0]:
        raise ValueError(f"normalization frequency {frequency_hz:g} Hz is outside the sampled range")
    for index in range(1, len(points)):
        lower_frequency, lower_value = points[index - 1]
        upper_frequency, upper_value = points[index]
        if frequency_hz <= upper_frequency:
            progress = math.log(frequency_hz / lower_frequency) / math.log(upper_frequency / lower_frequency)
            return lower_value + (upper_value - lower_value) * progress
    return points[-1][1]


def frequency_grid(min_hz, max_hz, samples_per_octave):
    step = 2 ** (1 / samples_per_octave)
    frequencies = []
    frequency_hz = min_hz
    while frequency_hz < max_hz:
        frequencies.append(frequency_hz)
        frequency_hz *= step
    frequencies.append(max_hz)
    return frequencies


def digitize(image, options):
    width, height = image.size
    if not 0 <= options.plot_left < options.plot_right <= width - 1:
        raise ValueError("plot x coordinates must be inside the image")
    if not 0 <= options.plot_top < options.plot_bottom <= height - 1:
        raise ValueError("plot y coordinates must be inside the image")
    if not 0 < options.axis_min_hz < options.axis_max_hz:
        raise ValueError("frequency axis limits are invalid")
    if not options.axis_min_hz <= options.frequency_min_hz < options.frequency_max_hz <= options.axis_max_hz:
        raise ValueError("sampled frequency limits must be inside the frequency axis")
    if not options.db_min < options.db_max:
        raise ValueError("dB axis limits are invalid")

    x_radius = max(1, round(options.x_radius))
    raw_points = []
    for frequency_hz in frequency_grid(
        options.frequency_min_hz,
        options.frequency_max_hz,
        options.samples_per_octave,
    ):
        x = frequency_to_x(
            frequency_hz,
            options.axis_min_hz,
            options.axis_max_hz,
            options.plot_left,
            options.plot_right,
        )
        y = find_trace_y(
            image,
            x,
            round(options.plot_top),
            round(options.plot_bottom),
            x_radius,
            options.trace_colors,
            options.color_tolerance,
        )
        if y is None:
            raise ValueError(f"could not find a configured trace near {frequency_hz:.1f} Hz")
        raw_points.append((frequency_hz, pixel_to_db(y, options.plot_top, options.plot_bottom, options.db_min, options.db_max)))

    normalize_at_hz = options.normalize_at_hz
    if normalize_at_hz is None and options.metadata and isinstance(options.metadata.get("normalizeAtHz"), (int, float)):
        normalize_at_hz = options.metadata["normalizeAtHz"]
    offset = interpolate_log(raw_points, normalize_at_hz) if normalize_at_hz is not None else 0
    points = [
        {
            "frequencyHz": round(frequency_hz, 1),
            "responseDb": round(response_db - offset, 1),
        }
        for frequency_hz, response_db in raw_points
    ]

    result = dict(options.metadata) if options.metadata else {}
    result["points"] = points
    return result


def build_parser():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--metadata", type=Path, help="JSON object to preserve while replacing its points")
    parser.add_argument("--plot-left", type=float, required=True)
    parser.add_argument("--plot-right", type=float, required=True)
    parser.add_argument("--plot-top", type=float, required=True)
    parser.add_argument("--plot-bottom", type=float, required=True)
    parser.add_argument("--axis-min-hz", type=float, required=True)
    parser.add_argument("--axis-max-hz", type=float, required=True)
    parser.add_argument("--frequency-min-hz", type=float, required=True)
    parser.add_argument("--frequency-max-hz", type=float, required=True)
    parser.add_argument("--db-min", type=float, required=True)
    parser.add_argument("--db-max", type=float, required=True)
    parser.add_argument("--trace-color", dest="trace_colors", type=parse_rgb, action="append", required=True, help="preferred trace RGB; repeat for fallback colors")
    parser.add_argument("--color-tolerance", type=float, default=35)
    parser.add_argument("--x-radius", type=float, default=2)
    parser.add_argument("--samples-per-octave", type=int, default=12)
    parser.add_argument("--normalize-at-hz", type=float)
    return parser


def main():
    options = build_parser().parse_args()
    if options.samples_per_octave <= 0:
        raise SystemExit("--samples-per-octave must be positive")
    if options.color_tolerance < 0 or options.x_radius < 0:
        raise SystemExit("color tolerance and x radius must not be negative")
    if options.metadata:
        try:
            metadata = json.loads(options.metadata.read_text(encoding="utf-8"))
        except json.JSONDecodeError as error:
            raise SystemExit(f"metadata is not valid JSON: {error}") from error
        if not isinstance(metadata, dict):
            raise SystemExit("metadata must contain a JSON object")
        options.metadata = metadata
    else:
        options.metadata = None

    with Image.open(options.image) as source:
        result = digitize(source.convert("RGB"), options)
    output = json.dumps(result, indent=2) + "\n"
    if options.output:
        options.output.write_text(output, encoding="utf-8")
    else:
        print(output, end="")


if __name__ == "__main__":
    main()
