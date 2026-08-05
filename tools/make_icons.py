"""
Generates the home screen icons for the two apps.

They have to be distinguishable at a glance on a home screen, which is the
whole point of shipping them as separate PWAs: a rising chart on navy for the
dividend tracker, a bank on blue for balances. Same silhouette or same colour
and you would have to read the label every time.

iOS applies its own rounded mask to apple-touch-icon, so those are generated
square and unrounded - rounding them here would show a dark halo inside Apple's
mask. The SVGs used by the web manifest are rounded, because nothing masks
those.

    python tools/make_icons.py
"""

from PIL import Image, ImageDraw, ImageFont
import os

DOCS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'docs')

NAVY = (15, 23, 42)
GREEN = (110, 231, 168)
PALE = (232, 237, 245)
BLUE = (11, 87, 208)
WHITE = (255, 255, 255)
MINT = (167, 243, 208)

SIZE = 1024  # drawn large, then downsampled, so the diagonals stay clean


def _canvas(bg):
    img = Image.new('RGB', (SIZE, SIZE), bg)
    return img, ImageDraw.Draw(img)


def draw_dividends():
    """A rising line with a marker: the existing icon, redrawn as a bitmap."""
    img, d = _canvas(NAVY)
    s = SIZE / 512.0
    pts = [(96, 352), (192, 256), (272, 320), (416, 160)]
    d.line([(x * s, y * s) for x, y in pts], fill=GREEN, width=int(34 * s), joint='curve')
    # Round the ends by hand; PIL's line has no linecap.
    for x, y in (pts[0], pts[-1]):
        r = 17 * s
        d.ellipse([x * s - r, y * s - r, x * s + r, y * s + r], fill=GREEN)
    r = 30 * s
    d.ellipse([416 * s - r, 160 * s - r, 416 * s + r, 160 * s + r], fill=GREEN)

    # The dollar sign. An S built by hand out of two arcs never reads as one at
    # 40px, so this uses a real font and centres on the glyph's measured bounds
    # rather than its advance box, which is what puts it visually off-centre.
    font = _load_font(int(220 * s))
    if font is not None:
        box = d.textbbox((0, 0), '$', font=font)
        d.text(
            (256 * s - (box[0] + box[2]) / 2, 404 * s - (box[1] + box[3]) / 2),
            '$', font=font, fill=PALE,
        )
    return img


def _load_font(size):
    """The first available bold sans-serif, or None if the box has no fonts."""
    candidates = [
        r'C:\Windows\Fonts\segoeuib.ttf',
        r'C:\Windows\Fonts\arialbd.ttf',
        '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
        '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    ]
    for path in candidates:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    print('WARNING: no bold font found; the dollar sign will be omitted')
    return None


def draw_balances():
    """A bank: pediment, columns, plinth. Reads clearly at 40px."""
    img, d = _canvas(BLUE)
    s = SIZE / 512.0

    def px(*vals):
        return [v * s for v in vals]

    d.polygon([(256 * s, 96 * s), (438 * s, 202 * s), (74 * s, 202 * s)], fill=WHITE)
    d.rectangle(px(74, 212, 438, 240), fill=WHITE)
    for x in (106, 188, 270, 352):
        d.rectangle(px(x, 258, x + 54, 372), fill=WHITE)
    d.rectangle(px(74, 388, 438, 416), fill=WHITE)
    # A coin, so it reads as money rather than architecture.
    d.ellipse(px(300, 300, 424, 424), fill=MINT)
    d.ellipse(px(316, 316, 408, 408), fill=BLUE)
    d.ellipse(px(330, 330, 394, 394), fill=MINT)
    return img


BALANCES_SVG = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="Bank balances">
  <rect width="512" height="512" rx="96" fill="#0b57d0"/>
  <polygon points="256,96 438,202 74,202" fill="#ffffff"/>
  <rect x="74" y="212" width="364" height="28" fill="#ffffff"/>
  <rect x="106" y="258" width="54" height="114" fill="#ffffff"/>
  <rect x="188" y="258" width="54" height="114" fill="#ffffff"/>
  <rect x="270" y="258" width="54" height="114" fill="#ffffff"/>
  <rect x="352" y="258" width="54" height="114" fill="#ffffff"/>
  <rect x="74" y="388" width="364" height="28" fill="#ffffff"/>
  <circle cx="362" cy="362" r="62" fill="#a7f3d0"/>
  <circle cx="362" cy="362" r="46" fill="#0b57d0"/>
  <circle cx="362" cy="362" r="32" fill="#a7f3d0"/>
</svg>
'''


def main():
    jobs = [
        (draw_dividends(), 'icon-180.png'),
        (draw_balances(), 'icon-balances-180.png'),
    ]
    for img, name in jobs:
        out = img.resize((180, 180), Image.LANCZOS)
        path = os.path.join(DOCS, name)
        out.save(path, 'PNG', optimize=True)
        print(f'{name:<26} {os.path.getsize(path):>6} bytes')

    svg_path = os.path.join(DOCS, 'icon-balances.svg')
    with open(svg_path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(BALANCES_SVG)
    print(f'{"icon-balances.svg":<26} {os.path.getsize(svg_path):>6} bytes')


if __name__ == '__main__':
    main()
