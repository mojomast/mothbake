#!/usr/bin/env python3
"""Regenerate the contact sheets in docs/images/.

The sheets are composed from bakes that `mothbake` produced earlier, so this
script never talks to the network. The few binary formats involved (Radiance
HDR, MIDI, WAV) are parsed in a hundred lines here, which keeps the sheets
reproducible with just python3, Pillow and numpy.

Inputs, all optional; sheets whose input is missing are skipped:

  --bakes <dir>      Directory of raw job outputs, one directory per job:
                       tex-rock/result.png        (or result-png)
                       normal-rock/result.json    ({"output": [[...]]} grid)
                       sky-ashen/result.png
                       effect-rift-0/result.json
                       entanglement/result-zip    (R_lut.hdr / T_lut.hdr)
                       ir-cavern/result.wav
                       motif-echo/result-midi
                     This is the shape of a downloaded `<out>/raw/<raw>/`
                     tree, or of the engine result cache of a project.

  --example <dir>    A `mothbake run` output directory (default `out/examples`):
                     used as a fallback for motifs/ (`*.json`), irs/ (`*.wav`
                     plus `*.json`) and materials/.

  --in-engine <png>  A real-time capture to crop (--in-engine-crop px off the
                     top, default 140) and re-encode as JPEG.

  --out <dir>        Output directory, default docs/images.

Requires: python3, Pillow, numpy.

Usage:
  python3 scripts/gallery.py \
      --bakes /path/to/raw \
      --example out/examples \
      --in-engine /path/to/screenshot.png \
      --out docs/images
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import wave
import zipfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

# --- palette ---------------------------------------------------------------

BG = (20, 22, 27)
PANEL = (30, 33, 40)
BORDER = (54, 59, 69)
FG = (235, 238, 243)
DIM = (151, 158, 170)
MUTED = (110, 117, 128)
TEAL = (96, 214, 199)
VIOLET = (176, 140, 255)
AMBER = (255, 178, 84)
ROSE = (255, 122, 158)

RAMPS = {
    'quantum': [(10, 30, 40), (40, 210, 200), (180, 120, 255), (240, 250, 255)],
    'ember': [(26, 8, 6), (180, 40, 20), (255, 150, 40), (255, 240, 200)],
    'plasma': [(10, 4, 30), (110, 30, 190), (255, 90, 160), (255, 240, 255)],
    'ice': [(4, 10, 26), (40, 120, 220), (150, 220, 255), (250, 255, 255)],
    'toxic': [(8, 20, 4), (70, 170, 40), (200, 240, 60), (255, 255, 220)],
}

FONT_CANDIDATES = [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
]
FONT_BOLD_CANDIDATES = [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
]
_font_cache: dict = {}


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    key = (size, bold)
    if key not in _font_cache:
        for path in FONT_BOLD_CANDIDATES if bold else FONT_CANDIDATES:
            if Path(path).exists():
                _font_cache[key] = ImageFont.truetype(path, size)
                break
        else:
            _font_cache[key] = ImageFont.load_default()
    return _font_cache[key]


# --- small drawing helpers -------------------------------------------------


def new_sheet(width: int, height: int):
    image = Image.new('RGB', (width, height), BG)
    return image, ImageDraw.Draw(image)


def label(draw, xy, message, size=13, color=DIM, bold=False, anchor=None):
    draw.text(xy, message, font=font(size, bold), fill=color, anchor=anchor)


def panel(draw, box, fill=PANEL, outline=BORDER):
    draw.rectangle(box, fill=fill, outline=outline, width=1)


def thumb(image: Image.Image, width: int, height: int) -> Image.Image:
    """Nearest-neighbour when magnifying pixel art, smooth when shrinking photos."""
    mag = image.width <= width and image.height <= height
    resample = Image.Resampling.NEAREST if mag else Image.Resampling.LANCZOS
    return image.convert('RGB').resize((width, height), resample)


# --- baking helpers (mirrors of src/image.mjs) -----------------------------


def resample_grid(grid, width: int, height: int) -> np.ndarray:
    values = np.asarray(grid, dtype=np.float64)
    rows, cols = values.shape
    if not rows or not cols:
        raise ValueError('grid: empty or ragged grid')
    span = values.max() - values.min() or 1.0
    norm = (values - values.min()) / span
    iy = np.minimum((np.arange(height) * rows) // height, rows - 1)
    ix = np.minimum((np.arange(width) * cols) // width, cols - 1)
    return norm[np.ix_(iy, ix)]


def grid_to_normal(field: np.ndarray, width: int, height: int, strength: float = 1.6) -> np.ndarray:
    f = field.reshape(height, width)
    dx = (np.roll(f, -1, axis=1) - np.roll(f, 1, axis=1)) * strength
    dy = (np.roll(f, -1, axis=0) - np.roll(f, 1, axis=0)) * strength
    length = np.sqrt(dx * dx + dy * dy + 1.0)
    rgb = np.stack([-dx / length * 0.5 + 0.5, -dy / length * 0.5 + 0.5, 1.0 / length * 0.5 + 0.5], axis=-1)
    return np.clip(np.rint(rgb * 255), 0, 255).astype(np.uint8)


def grid_to_ramp(field: np.ndarray, width: int, height: int, ramp) -> np.ndarray:
    stops = np.asarray(ramp, dtype=np.float64)
    t = np.clip(field.reshape(-1), 0, 0.9999) * (len(stops) - 1)
    low = np.floor(t).astype(int)
    frac = (t - low)[:, None]
    rgb = stops[low] * (1 - frac) + stops[np.minimum(low + 1, len(stops) - 1)] * frac
    return np.clip(np.rint(rgb), 0, 255).astype(np.uint8).reshape(height, width, 3)


def hdr_decode(buf: bytes):
    """Flat and modern-RLE Radiance RGBE, matching src/decoders/hdr.mjs."""
    pos = 0

    def read_line() -> bytes:
        nonlocal pos
        end = buf.find(b'\n', pos)
        if end < 0:
            raise ValueError('hdr: truncated header')
        line = buf[pos:end]
        pos = end + 1
        return line

    if not read_line().startswith(b'#?'):
        raise ValueError('hdr: not a Radiance HDR file')
    while True:
        line = read_line()
        if line == b'':
            break
    match = re.match(rb'-Y\s+(\d+)\s+\+X\s+(\d+)', read_line())
    if not match:
        raise ValueError('hdr: resolution line (-Y h +X w) missing')
    height, width = int(match[1]), int(match[2])
    data = buf[pos:]
    out = np.zeros((height, width, 3), np.float32)
    off = 0
    for y in range(height):
        if (
            width >= 8
            and width < 32768
            and data[off] == 2
            and data[off + 1] == 2
            and ((data[off + 2] << 8) | data[off + 3]) == width
        ):
            off += 4
            channels = np.empty((4, width), np.uint8)
            for c in range(4):
                x = 0
                while x < width:
                    count = data[off]
                    off += 1
                    if count > 128:
                        channels[c, x : x + count - 128] = data[off]
                        off += 1
                        x += count - 128
                    else:
                        channels[c, x : x + count] = data[off : off + count]
                        off += count
                        x += count
        else:
            channels = np.frombuffer(data[off : off + width * 4], np.uint8).reshape(width, 4).T
            off += width * 4
        scale = np.exp2(channels[3].astype(np.float32) - 136)
        rgb = channels[:3].astype(np.float32) * scale
        rgb[:, channels[3] == 0] = 0
        out[y] = rgb.T
    return out


def read_midi(buf: bytes):
    """Standard MIDI file -> (ppq, bpm, [{tick, dur, midi, vel}]), matching src/decoders/midi.mjs."""
    if len(buf) < 14 or buf[:4] != b'MThd':
        raise ValueError('midi: not a Standard MIDI File')
    header_length = int.from_bytes(buf[4:8], 'big')
    division = int.from_bytes(buf[12:14], 'big')
    if division & 0x8000:
        raise ValueError('midi: SMPTE time division unsupported')
    ppq = division or 480
    offset = 8 + header_length
    bpm = 120
    notes = []
    active = {}

    def read_vlq(offset, end):
        value = 0
        while True:
            byte = buf[offset]
            offset += 1
            value = (value << 7) | (byte & 0x7F)
            if not byte & 0x80:
                return value, offset

    def close(pitch, tick):
        started = active.pop(pitch, None)
        if started:
            notes.append({'tick': started[0], 'dur': max(1, tick - started[0]), 'midi': pitch, 'vel': started[1]})

    while offset + 8 <= len(buf):
        chunk = buf[offset : offset + 4]
        length = int.from_bytes(buf[offset + 4 : offset + 8], 'big')
        if chunk != b'MTrk':
            offset += 8 + length
            continue
        end = min(len(buf), offset + 8 + length)
        offset += 8
        tick = 0
        running = 0
        while offset < end:
            delta, offset = read_vlq(offset, end)
            tick += delta
            status = buf[offset]
            if status & 0x80:
                offset += 1
                running = status
            else:
                status = running
            kind = status & 0xF0
            if kind == 0x90:
                pitch, velocity = buf[offset], buf[offset + 1]
                offset += 2
                if velocity > 0:
                    active[pitch] = (tick, velocity)
                else:
                    close(pitch, tick)
            elif kind == 0x80:
                close(buf[offset], tick)
                offset += 2
            elif kind in (0xA0, 0xB0, 0xE0):
                offset += 2
            elif kind in (0xC0, 0xD0):
                offset += 1
            elif status == 0xFF:
                meta = buf[offset]
                offset += 1
                size, offset = read_vlq(offset, end)
                if meta == 0x51 and size == 3:
                    bpm = round(60000000 / int.from_bytes(buf[offset : offset + 3], 'big'))
                offset += size
            elif status in (0xF0, 0xF7):
                size, offset = read_vlq(offset, end)
                offset += size
            else:
                offset += 1
        offset = end
    notes.sort(key=lambda note: (note['tick'], note['midi']))
    return ppq, bpm, notes


# --- locating job outputs --------------------------------------------------


def is_image(path: Path) -> bool:
    try:
        with Image.open(path) as image:
            image.load()
        return True
    except Exception:
        return False


def job_dir(bakes: Path, name: str) -> Path | None:
    candidate = bakes / name
    return candidate if candidate.is_dir() else None


def result_files(bakes: Path, name: str):
    directory = job_dir(bakes, name)
    if directory is None:
        return []
    return sorted(path for path in directory.iterdir() if path.name.startswith('result'))


def find_image(bakes: Path, name: str) -> Path | None:
    for path in result_files(bakes, name):
        if not path.name.endswith('.json') and not path.name.endswith('-zip') and is_image(path):
            return path
    return None


def find_json(bakes: Path, name: str):
    directory = job_dir(bakes, name)
    if directory is None:
        return None
    candidates = result_files(bakes, name)
    candidates += sorted(path for path in directory.iterdir() if path.suffix == '.json' or path.name.endswith('-json'))
    for path in candidates:
        try:
            return json.loads(path.read_text())
        except Exception:
            continue
    return None


def unwrap_result(value):
    """Mirror outputOf() in src/bakers/util.mjs: result/result.output/output."""
    for _ in range(4):
        if not isinstance(value, dict):
            break
        if 'output' in value:
            value = value['output']
        elif 'result' in value:
            value = value['result']
        else:
            return None
    return value


def find_grid(bakes: Path, name: str):
    value = unwrap_result(find_json(bakes, name))
    return value if isinstance(value, list) and value and isinstance(value[0], list) else None


TAP_KEYS = ('taps', 'tap_map', 'ir', 'feedback_taps')


def taps_from(value, depth=0, seen=None):
    """Mirror tapsFrom() in src/bakers/ir.mjs."""
    if seen is None:
        seen = set()
    if not isinstance(value, (dict, list)) or depth > 4 or id(value) in seen:
        return None
    seen.add(id(value))
    if isinstance(value, dict):
        for key in TAP_KEYS:
            child = value.get(key)
            if isinstance(child, list) and child:
                return child
        for child in value.values():
            found = taps_from(child, depth + 1, seen)
            if found:
                return found
    else:
        for child in value:
            found = taps_from(child, depth + 1, seen)
            if found:
                return found
    return None


def timed_taps(taps):
    return taps if taps and isinstance(taps[0], dict) and 'time_ms' in taps[0] else None


def find_taps(bakes: Path, name: str):
    directory = job_dir(bakes, name)
    if directory is None:
        return None
    first = None
    for path in sorted(directory.iterdir()):
        if path.is_dir() or path.suffix.lower() in ('.wav', '.mid', '.png', '.jpg', '.zip', '.hdr', '.exr'):
            continue
        try:
            value = json.loads(path.read_text())
        except Exception:
            continue
        found = taps_from(value)
        if found and timed_taps(found):
            return found
        if found and first is None:
            first = found
    return first


def find_zip(bakes: Path, name: str) -> Path | None:
    for path in result_files(bakes, name):
        if zipfile.is_zipfile(path):
            return path
    return None


def find_wav(bakes: Path, name: str) -> Path | None:
    for path in result_files(bakes, name):
        if path.suffix == '.wav' or path.name.endswith('-wav'):
            return path
    return None


def find_midi(bakes: Path, name: str) -> Path | None:
    for path in result_files(bakes, name):
        if path.name.endswith('-midi') or path.suffix == '.mid':
            return path
    return None


def write(image: Image.Image, out: Path, name: str):
    path = out / name
    out.mkdir(parents=True, exist_ok=True)
    if name.endswith('.jpg'):
        image.save(path, 'JPEG', quality=85, optimize=True, progressive=True)
    else:
        image.save(path, 'PNG', optimize=True)
    print(f'  {name:<24} {image.width}x{image.height}  {path.stat().st_size / 1024:7.1f} KB')


# --- sheets ----------------------------------------------------------------


def sheet_textures(bakes: Path, example: Path | None, out: Path):
    jobs = [
        ('tex-grass', 'grass'), ('tex-sand', 'sand'), ('tex-hazard', 'hazard'),
        ('tex-circuit', 'circuit'), ('tex-diamond', 'diamond'), ('tex-chitin', 'chitin'),
        ('tex-mesh', 'mesh'), ('tex-grating', 'grating'), ('tex-riveted', 'riveted'),
        ('tex-corrugated', 'corrugated'), ('tex-macro', 'macro'), ('tex-stucco', 'stucco'),
        ('tex-metal', 'metal'), ('tex-ice', 'ice'), ('tex-steel-wall', 'steel-wall'), ('tex-carbon', 'carbon'),
        ('tex-hull', 'hull'), ('blur-panel', 'panel'),
    ]
    entries = []
    for name, text in jobs:
        path = find_image(bakes, name)
        if path is None and example is not None:
            candidate = example / 'textures' / f'{name.replace("tex-", "")}.png'
            if candidate.exists():
                path = candidate
        if path:
            entries.append((text, Image.open(path).convert('RGBA')))
    if not entries:
        return False

    cols, tile, gap, pad, cap = 6, 160, 12, 24, 22
    rows = (len(entries) + cols - 1) // cols
    width = pad * 2 + cols * tile + (cols - 1) * gap
    height = pad * 2 + rows * (tile + cap) + (rows - 1) * gap
    image, draw = new_sheet(width, height)
    for index, (text, source) in enumerate(entries):
        x = pad + (index % cols) * (tile + gap)
        y = pad + (index // cols) * (tile + cap + gap)
        panel(draw, (x - 1, y - 1, x + tile, y + tile), BG, BORDER)
        image.paste(thumb(source, tile, tile), (x, y))
        label(draw, (x + tile / 2, y + tile + 5), text, 12, DIM, anchor='ma')
    write(image, out, 'gallery-textures.png')
    return True


def sheet_normals(bakes: Path, out: Path):
    jobs = [
        ('normal-rock', 'rock'), ('normal-sand', 'sand'), ('normal-grass', 'grass'),
        ('normal-ice', 'ice'), ('normal-metal', 'metal'), ('normal-hazard', 'hazard'),
        ('normal-concrete', 'concrete'), ('normal-stucco', 'stucco'), ('normal-corrugated', 'corrugated'),
        ('normal-diamond', 'diamond'), ('normal-grating', 'grating'), ('normal-hex', 'hex'),
        ('normal-hologrid', 'hologrid'),
    ]
    entries = []
    for name, text in jobs:
        grid = find_grid(bakes, name)
        if grid:
            size, strength = 128, 4.0
            field = resample_grid(grid, size, size)
            entries.append((text, grid_to_normal(field, size, size, strength)))
    if not entries:
        return False

    cols, tile, gap, pad, cap = 5, 128, 14, 24, 22
    rows = (len(entries) + cols - 1) // cols
    width = pad * 2 + cols * tile + (cols - 1) * gap
    height = pad * 2 + rows * (tile + cap) + (rows - 1) * gap
    image, draw = new_sheet(width, height)
    for index, (text, rgb) in enumerate(entries):
        x = pad + (index % cols) * (tile + gap)
        y = pad + (index // cols) * (tile + cap + gap)
        panel(draw, (x - 1, y - 1, x + tile, y + tile), BG, BORDER)
        image.paste(Image.fromarray(rgb, 'RGB'), (x, y))
        label(draw, (x + tile / 2, y + tile + 5), text, 12, DIM, anchor='ma')
    write(image, out, 'gallery-normals.png')
    return True


def sheet_skies(bakes: Path, out: Path):
    jobs = [('sky-ashen', 'ashen'), ('sky-frost', 'frost'), ('sky-void', 'void')]
    entries = []
    for name, text in jobs:
        path = find_image(bakes, name)
        if path:
            source = Image.open(path).convert('RGB')
            entries.append((text, source))
    if not entries:
        return False

    width_each, gap, pad, cap = 384, 16, 24, 24
    width = pad * 2 + len(entries) * width_each + (len(entries) - 1) * gap
    height = pad * 2 + width_each // 2 + cap
    image, draw = new_sheet(width, height)
    for index, (text, source) in enumerate(entries):
        x = pad + index * (width_each + gap)
        y = pad
        panel(draw, (x - 1, y - 1, x + width_each, y + width_each // 2), BG, BORDER)
        image.paste(thumb(source, width_each, width_each // 2), (x, y))
        label(draw, (x + width_each / 2, y + width_each // 2 + 6), text, 13, DIM, anchor='ma')
    write(image, out, 'gallery-skies.png')
    return True


def sheet_effects(bakes: Path, out: Path):
    groups: dict = {}
    if bakes.is_dir():
        for directory in sorted(bakes.iterdir()):
            match = re.match(r'^effect-(.+)-(\d+)$', directory.name)
            if not match:
                continue
            groups.setdefault(match[1], []).append((int(match[2]), directory))
    order = ['rift', 'portal', 'spark']
    ramps = {'rift': 'quantum', 'portal': 'plasma', 'spark': 'ember'}
    names = [name for name in order if name in groups] + [name for name in sorted(groups) if name not in order]
    if not names:
        return False

    rows = []
    for name in names:
        frames = []
        for _, directory in sorted(groups[name]):
            grid = find_grid(directory.parent, directory.name)
            if grid:
                size = 144
                field = resample_grid(grid, size, size)
                frames.append((name, grid_to_ramp(field, size, size, RAMPS[ramps.get(name, 'quantum')])))
        if frames:
            rows.append((name, frames))
    if not rows:
        return False

    tile, gap, pad, label_w, header = 144, 10, 24, 104, 20
    cols = max(len(frames) for _, frames in rows)
    width = pad * 2 + label_w + cols * tile + (cols - 1) * gap
    height = pad * 2 + header + len(rows) * (tile + 12)
    image, draw = new_sheet(width, height)
    for column in range(cols):
        x = pad + label_w + column * (tile + gap)
        label(draw, (x + tile / 2, pad - 4), f'frame {column}', 12, MUTED, anchor='ms')
    for row, (name, frames) in enumerate(rows):
        y = pad + header + row * (tile + 12)
        label(draw, (pad + label_w - 14, y + tile / 2), name, 14, FG, bold=True, anchor='rm')
        label(draw, (pad + label_w - 14, y + tile / 2 + 16), f'{len(frames)} frames', 11, MUTED, anchor='rm')
        for column, (_, rgb) in enumerate(frames):
            x = pad + label_w + column * (tile + gap)
            panel(draw, (x - 1, y - 1, x + tile, y + tile), BG, BORDER)
            image.paste(Image.fromarray(rgb, 'RGB'), (x, y))
    write(image, out, 'gallery-effects.png')
    return True


def sheet_luts(bakes: Path, out: Path):
    packs = [('entanglement', 'iridescent'), ('entanglement-arcane', 'arcane'), ('entanglement-ember', 'ember')]
    entries = []
    for name, text in packs:
        archive = find_zip(bakes, name)
        if not archive:
            continue
        try:
            with zipfile.ZipFile(archive) as zip_file:
                lobes = {}
                for entry in zip_file.namelist():
                    lowered = entry.lower()
                    if lowered.endswith('r_lut.hdr'):
                        lobes['r'] = hdr_decode(zip_file.read(entry))
                    elif lowered.endswith('t_lut.hdr'):
                        lobes['t'] = hdr_decode(zip_file.read(entry))
        except Exception as error:  # pragma: no cover - defensive
            print(f'  lut {name}: {error}', file=sys.stderr)
            continue
        if 'r' in lobes and 't' in lobes:
            entries.append((text, lobes['r'], lobes['t']))
    if not entries:
        return False

    tile, gap, pad, label_w, header = 156, 10, 24, 124, 22
    width = pad * 2 + label_w + 2 * tile + gap
    height = pad * 2 + header + len(entries) * (tile + 12)
    image, draw = new_sheet(width, height)
    label(draw, (pad + label_w + tile / 2, pad - 4), 'reflectance (R)', 12, MUTED, anchor='ms')
    label(draw, (pad + label_w + tile + gap + tile / 2, pad - 4), 'transmittance (T)', 12, MUTED, anchor='ms')
    for row, (text, r_lobe, t_lobe) in enumerate(entries):
        y = pad + header + row * (tile + 12)
        label(draw, (pad + label_w - 14, y + tile / 2), text, 14, FG, bold=True, anchor='rm')
        label(draw, (pad + label_w - 14, y + tile / 2 + 16), f'{r_lobe.shape[0]}x{r_lobe.shape[1]} px', 11, MUTED, anchor='rm')
        for column, lobe in enumerate((r_lobe, t_lobe)):
            low, high = float(lobe.min()), float(lobe.max())
            span = high - low or 1.0
            rgb = np.clip(np.rint((lobe - low) / span * 255), 0, 255).astype(np.uint8)
            thumb_image = Image.fromarray(rgb, 'RGB').resize((tile, tile), Image.Resampling.NEAREST)
            x = pad + label_w + column * (tile + gap)
            panel(draw, (x - 1, y - 1, x + tile, y + tile), BG, BORDER)
            image.paste(thumb_image, (x, y))
    write(image, out, 'gallery-luts.png')
    return True


def sheet_motifs(bakes: Path, example: Path | None, out: Path):
    motifs = []
    if bakes.is_dir():
        for directory in sorted(bakes.iterdir()):
            match = re.match(r'^motif-(.+)$', directory.name)
            if not match:
                continue
            midi = find_midi(bakes, directory.name)
            if not midi:
                continue
            ppq, bpm, notes = read_midi(midi.read_bytes())
            sixteenth = (ppq or 480) / 4
            steps = [
                {
                    'step': round(note['tick'] / sixteenth),
                    'dur': max(1, round(note['dur'] / sixteenth)),
                    'midi': note['midi'],
                    'vel': note['vel'],
                }
                for note in notes
            ]
            if steps:
                motifs.append((match[1], bpm, ppq, steps))
    if not motifs and example is not None and (example / 'motifs').is_dir():
        for path in sorted((example / 'motifs').glob('*.json')):
            value = json.loads(path.read_text())
            motifs.append((path.stem, value.get('bpm', 120), value.get('ppq', 480), value.get('notes', [])))
        motifs = [entry for entry in motifs if entry[3]]
    if not motifs:
        return False

    order = ['echo', 'oracle']
    motifs.sort(key=lambda entry: (order.index(entry[0]) if entry[0] in order else len(order), entry[0]))
    motifs = motifs[:3]

    step_w, key_w, pad, row_gap, header = 7, 15, 24, 34, 22
    max_step = max(max(note['step'] + note['dur'] for note in notes) for _, _, _, notes in motifs)
    width = pad * 2 + key_w + max_step * step_w + 12
    row_heights = []
    for _, _, _, notes in motifs:
        low = max(0, min(note['midi'] for note in notes) - 1)
        high = min(127, max(note['midi'] for note in notes) + 1)
        row_heights.append((low, high, (high - low + 1) * 13))
    height = pad * 2 + header * len(motifs) + sum(row[2] for row in row_heights) + row_gap * (len(motifs) - 1)
    image, draw = new_sheet(width, height)

    colors = {'echo': TEAL, 'oracle': VIOLET}
    y = pad
    for (name, bpm, ppq, notes), (low, high, roll_h) in zip(motifs, row_heights):
        color = colors.get(name, AMBER)
        label(draw, (pad, y), name, 14, FG, bold=True)
        label(draw, (pad + 8 + draw.textlength(name, font=font(14, True)), y + 1), f'{len(notes)} notes · {bpm} bpm · ppq {ppq}', 12, MUTED)
        roll_y = y + header
        # piano-key strip
        for pitch in range(low, high + 1):
            key_y = roll_y + (high - pitch) * 13
            black = pitch % 12 in (1, 3, 6, 8, 10)
            draw.rectangle((pad, key_y, pad + key_w - 1, key_y + 12), fill=BORDER if black else (198, 203, 210))
        panel(draw, (pad + key_w, roll_y - 1, pad + key_w + max_step * step_w, roll_y + roll_h), PANEL, BORDER)
        for step in range(0, max_step + 1, 4):
            x = pad + key_w + step * step_w
            strong = step % 16 == 0
            draw.line((x, roll_y, x, roll_y + roll_h), fill=(72, 78, 90) if strong else (42, 46, 54), width=1)
        for pitch in range(low, high + 1):
            if pitch % 12 == 0:
                y_line = roll_y + (high - pitch) * 13
                draw.line((pad + key_w, y_line + 12, pad + key_w + max_step * step_w, y_line + 12), fill=(42, 46, 54), width=1)
        for note in notes:
            x = pad + key_w + note['step'] * step_w
            note_y = roll_y + (high - note['midi']) * 13
            bar_w = max(2, note['dur'] * step_w - 1)
            shade = 0.55 + 0.45 * min(1.0, note['vel'] / 127)
            bar = tuple(round(channel * shade) for channel in color)
            draw.rounded_rectangle((x, note_y + 1, x + bar_w, note_y + 11), radius=2, fill=bar)
        y += header + roll_h + row_gap
    write(image, out, 'gallery-motifs.png')
    return True


def sheet_ir(bakes: Path, example: Path | None, out: Path):
    wav_path = None
    taps = None
    if bakes.is_dir():
        for directory in sorted(bakes.iterdir()):
            if not re.match(r'^ir-', directory.name):
                continue
            wav_path = find_wav(bakes, directory.name)
            if wav_path:
                taps = find_taps(bakes, directory.name)
                break
    if example is not None and (example / 'irs').is_dir():
        for descriptor_path in sorted((example / 'irs').glob('*.json')):
            descriptor = json.loads(descriptor_path.read_text())
            if timed_taps(descriptor.get('taps')):
                taps = descriptor['taps']
                if wav_path is None:
                    candidate = descriptor_path.with_suffix('.wav')
                    if candidate.exists():
                        wav_path = candidate
                break
    if wav_path is None or not Path(wav_path).exists():
        return False
    taps = timed_taps(taps)

    with wave.open(str(wav_path), 'rb') as handle:
        channels = handle.getnchannels()
        sample_rate = handle.getframerate()
        frames = handle.readframes(handle.getnframes())
    samples = np.frombuffer(frames, dtype='<i2').astype(np.float32) / 32768.0
    if channels > 1:
        samples = samples.reshape(-1, channels)
    else:
        samples = samples[:, None]
    seconds = samples.shape[0] / sample_rate

    pad, width = 24, 1200
    plot_w = width - pad * 2
    wave_h, taps_h, header, axis, taps_header = 190, 116, 22, 18, 24
    height = pad * 2 + header + wave_h + axis + taps_header + taps_h + axis
    image, draw = new_sheet(width, height)

    header_y = pad
    label(draw, (pad, header_y), 'waveform', 14, FG, bold=True)
    info_x = pad + draw.textlength('waveform', font=font(14, True)) + 10
    label(draw, (info_x, header_y + 1), f'{wav_path.name} · {seconds:.2f} s · {sample_rate} Hz · {channels} ch · dB envelope', 12, MUTED)

    wave_y = header_y + header
    panel(draw, (pad, wave_y, pad + plot_w, wave_y + wave_h), PANEL, BORDER)
    floor_db = 60.0
    overlay = Image.new('RGBA', (plot_w, wave_h), (0, 0, 0, 0))
    overlay_draw = ImageDraw.Draw(overlay)
    columns = plot_w
    bucket = max(1, samples.shape[0] // columns)
    usable = bucket * columns
    chunk = samples[:usable].reshape(columns, bucket, channels)
    peak = float(np.abs(chunk).max()) or 1.0
    levels = np.abs(chunk).max(axis=1) / peak
    colors = [(96, 214, 199), (176, 140, 255)]
    for channel in range(min(channels, 2)):
        color = colors[channel]
        db = np.clip(-20.0 * np.log10(np.maximum(levels[:, channel], 1e-9)), 0.0, floor_db)
        base = 5.0
        span = wave_h - base - 5.0
        ys = base + (db / floor_db) * span
        for column in range(columns):
            if channel == 0:
                overlay_draw.line((column, base, column, ys[column]), fill=color + (64,))
        edge = [(column, float(ys[column])) for column in range(columns)]
        overlay_draw.line(edge, fill=color + (235 if channel == 0 else 170,), width=1)
    if taps:
        for tap in taps:
            x = min(plot_w - 1, max(0, tap['time_ms'] / 1000 / seconds * plot_w))
            overlay_draw.line((x, 0, x, wave_h), fill=(255, 178, 84, 80))
    image.paste(overlay, (pad, wave_y), overlay)
    for db in (0, -20, -40, -60):
        y = wave_y + 5 + (-db / floor_db) * (wave_h - 10)
        draw.line((pad, y, pad + plot_w, y), fill=(44, 49, 58), width=1)
        label(draw, (pad + plot_w - 6, y + 2), f'{db} dB', 10, MUTED, anchor='ra')
    for fraction in range(5):
        x = pad + plot_w * fraction / 4
        draw.line((x, wave_y + wave_h, x, wave_y + wave_h + 4), fill=BORDER)
        label(draw, (x, wave_y + wave_h + 5), f'{seconds * fraction / 4:.1f}s', 11, MUTED, anchor='ma')

    taps_y = wave_y + wave_h + axis + taps_header
    label(draw, (pad, taps_y - taps_header + 1), 'tap map', 14, FG, bold=True)
    count = len(taps or [])
    taps_info = f'{count} taps · level vs time · radius by depth' if taps else 'no timed tap map in the inputs'
    label(draw, (pad + draw.textlength('tap map', font=font(14, True)) + 10, taps_y - taps_header + 2), taps_info, 12, MUTED)
    panel(draw, (pad, taps_y, pad + plot_w, taps_y + taps_h), PANEL, BORDER)
    for fraction in (0.5, 1.0):
        y = taps_y + taps_h - 4 - fraction * (taps_h - 12)
        draw.line((pad, y, pad + plot_w, y), fill=(44, 49, 58), width=1)
    if taps:
        domain = max(tap['time_ms'] for tap in taps) / 1000 * 1.08 or 1.0
        levels = [tap.get('level', 0) for tap in taps]
        high = max(levels) or 1.0
        for tap in taps:
            x = pad + min(plot_w - 1, max(0, tap['time_ms'] / 1000 / domain * plot_w))
            y = taps_y + taps_h - 4 - (tap.get('level', 0) / high) * (taps_h - 12)
            radius = 2 + min(3.0, float(tap.get('depth', 1)) / 3)
            draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=AMBER)
        for step in range(5):
            x = pad + plot_w * step / 4
            draw.line((x, taps_y + taps_h, x, taps_y + taps_h + 4), fill=BORDER)
            label(draw, (x, taps_y + taps_h + 5), f'{domain * 1000 * step / 4:.0f} ms', 11, MUTED, anchor='ma')
    write(image, out, 'gallery-ir.png')
    return True


def in_engine(source: Path, out: Path, crop_top: int):
    if not source.exists():
        return False
    image = Image.open(source).convert('RGB')
    if crop_top:
        image = image.crop((0, crop_top, image.width, image.height))
    if image.width > 1280:
        image = image.resize((1280, round(image.height * 1280 / image.width)), Image.Resampling.LANCZOS)
    write(image, out, 'in-engine.jpg')
    return True


# --- main ------------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--bakes', type=Path, help='directory of raw job output directories')
    parser.add_argument('--example', type=Path, default=Path('out/examples'), help='a mothbake run output directory')
    parser.add_argument('--in-engine', type=Path, help='screenshot to crop and re-encode')
    parser.add_argument('--in-engine-crop', type=int, default=140, help='pixels to crop off the top (default 140)')
    parser.add_argument('--out', type=Path, default=Path('docs/images'), help='output directory (default docs/images)')
    parser.add_argument('--only', help='comma-separated subset: textures,normals,skies,effects,luts,motifs,ir,in-engine')
    args = parser.parse_args()

    example = args.example if args.example and args.example.is_dir() else None
    bakes = args.bakes if args.bakes and args.bakes.is_dir() else Path('.missing-bakes')
    if args.bakes and not args.bakes.is_dir():
        parser.error(f'--bakes directory not found: {args.bakes}')
    wanted = set(args.only.split(',')) if args.only else None

    def run(name, function):
        if wanted and name not in wanted:
            return
        print(f'{name}:')
        try:
            if not function():
                print('  skipped (no input)')
        except Exception as error:  # keep the other sheets going
            print(f'  failed: {error}', file=sys.stderr)

    run('textures', lambda: sheet_textures(bakes, example, args.out))
    run('normals', lambda: sheet_normals(bakes, args.out))
    run('skies', lambda: sheet_skies(bakes, args.out))
    run('effects', lambda: sheet_effects(bakes, args.out))
    run('luts', lambda: sheet_luts(bakes, args.out))
    run('motifs', lambda: sheet_motifs(bakes, example, args.out))
    run('ir', lambda: sheet_ir(bakes, example, args.out))
    run('in-engine', lambda: in_engine(args.in_engine, args.out, args.in_engine_crop) if args.in_engine else False)

    total = sum(path.stat().st_size for path in args.out.glob('*') if path.suffix in ('.png', '.jpg'))
    print(f'total gallery: {total / 1024 / 1024:.2f} MB')
    return 0


if __name__ == '__main__':
    sys.exit(main())
