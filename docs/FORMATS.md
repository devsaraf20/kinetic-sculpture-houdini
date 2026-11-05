# Height export format (`kinetic-sculpture-heights` v1)

Written by the Houdini and Blender exporters and by the web app. Read by the
web app and `tools/pbridge.py`. The file holds one height per ball per frame,
in millimetres.

* **0 mm = fully lowered** (bottom of travel). Larger is higher.
* Balls are listed **row-major**: row 0 col 0, row 0 col 1, …
* Rows run along +Z in Houdini (+Y in Blender), columns along +X.
* The frame rate is the playback rate. Frames are evenly spaced.

## JSON

```json
{
  "format": "kinetic-sculpture-heights",
  "version": 1,
  "source": "houdini:/obj/kinetic_sculpture/OUT_HEIGHTS",
  "units": "mm",
  "fps": 30,
  "frame_start": 1,
  "frame_count": 601,
  "grid": {"rows": 8, "cols": 8, "spacing_mm": 100},
  "range_mm": [0, 800],
  "balls": [
    {"index":0,"row":0,"col":0},
    {"index":1,"row":0,"col":1}
  ],
  "frames": [
    [400, 400.5, 401.2],
    [400.1, 400.9, 401.8]
  ]
}
```

| Field | Required | Meaning |
|---|---|---|
| `format`, `version` | recommended | identifies the file |
| `fps` | yes | frames per second |
| `frames` | yes | `frame_count` arrays, each with one height (mm) per ball in `balls` order |
| `grid.rows`, `grid.cols` | recommended | guessed from the ball count if missing |
| `balls` | optional | `row`/`col` per ball; defaults to row-major order |
| `grid.spacing_mm` | optional | distance between neighbouring balls (used by the 3D view) |
| `range_mm` | optional | travel range the animation was designed for; the web app adopts it as the limit |
| `frame_start` | optional | scene frame number of the first frame (information only) |
| `source` | optional | free text |
| `balls[].name` | optional | e.g. the Houdini/Blender object name |

## CSV (wide)

Metadata goes in `# key=value` comment lines. Then comes one header row and one
row per frame. Ball columns are named `r<row>c<col>`. The `frame` and `time_s`
columns are optional.

```
# format=kinetic-sculpture-heights
# version=1
# fps=30
# rows=8
# cols=8
# spacing_mm=100
# units=mm
# range_mm=0,800
frame,time_s,r0c0,r0c1,r0c2,...
1,0.0000,400,400.5,401.2,...
2,0.0333,400.1,400.9,401.8,...
```

If the ball columns have other names, they are taken in column order and the
grid comes from `# rows=` / `# cols=` or is guessed.

The Physical Bridge format (motor steps) is described in
[PHYSICAL_BRIDGE.md](PHYSICAL_BRIDGE.md).
