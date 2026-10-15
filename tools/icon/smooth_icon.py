"""CookieGate shipped icon (v0.1.6+): smooth cookie with a bite + indigo shield check.

Usage:  python3 smooth_icon.py [output_dir]
Writes cookiegate_{16,32,48,64,128,256,512}.png and cookiegate_icon_master.svg.
Requires pycairo. 16px uses "tiny" detail, 32px "mid", 48px+ "full".
Restored 2026-10-13 from the original generator used for the v0.1.6/v0.1.7 release.
"""
import math, os, sys
import cairo

def hexc(h, a=1.0):
    h = h.lstrip('#'); return (int(h[0:2], 16)/255, int(h[2:4], 16)/255, int(h[4:6], 16)/255, a)

def rrect(cr, x, y, w, h, r):
    cr.new_sub_path(); cr.arc(x+w-r, y+r, r, -math.pi/2, 0); cr.arc(x+w-r, y+h-r, r, 0, math.pi/2)
    cr.arc(x+r, y+h-r, r, math.pi/2, math.pi); cr.arc(x+r, y+r, r, math.pi, 1.5*math.pi); cr.close_path()

def shield_path(cr, cx, top, w, h):
    l, r = cx-w/2, cx+w/2; b = top+h
    cr.move_to(cx, top)
    cr.curve_to(cx+w*0.22, top+h*0.07, r-w*0.02, top+h*0.06, r, top+h*0.10)
    cr.line_to(r, top+h*0.46)
    cr.curve_to(r, top+h*0.74, cx+w*0.22, b-h*0.06, cx, b)
    cr.curve_to(cx-w*0.22, b-h*0.06, l, top+h*0.74, l, top+h*0.46)
    cr.line_to(l, top+h*0.10)
    cr.curve_to(l+w*0.02, top+h*0.06, cx-w*0.22, top+h*0.07, cx, top)
    cr.close_path()

def draw(cr, detail):
    S = 1024
    g = cairo.LinearGradient(0, 0, 0, S); g.add_color_stop_rgba(0, *hexc('#252b3d')); g.add_color_stop_rgba(1, *hexc('#0e1118'))
    rrect(cr, 0, 0, S, S, 230); cr.set_source(g); cr.fill()
    if detail != "tiny":
        rrect(cr, 6, 6, S-12, S-12, 224); cr.set_source_rgba(*hexc('#ffffff', 0.07)); cr.set_line_width(12); cr.stroke()
    cx, cy, R = (452, 486, 318) if detail == "tiny" else (458, 486, 300)
    cr.push_group()
    rg = cairo.RadialGradient(cx-R*0.35, cy-R*0.4, R*0.1, cx, cy, R*1.05)
    rg.add_color_stop_rgba(0, *hexc('#f3c27f')); rg.add_color_stop_rgba(0.65, *hexc('#d9954d')); rg.add_color_stop_rgba(1, *hexc('#b8733a'))
    cr.arc(cx, cy, R, 0, 2*math.pi); cr.set_source(rg); cr.fill()
    if detail != "tiny":
        cr.arc(cx, cy, R-9, 0, 2*math.pi); cr.set_source_rgba(*hexc('#8f5420', 0.55)); cr.set_line_width(18); cr.stroke()
    chips = {"full": [(330, 380, 40), (468, 330, 34), (380, 520, 44), (520, 470, 30), (300, 630, 36), (455, 640, 40), (590, 560, 30), (398, 430, 22), (560, 385, 24)],
             "mid": [(345, 390, 52), (395, 560, 56), (500, 470, 44), (300, 640, 46), (470, 650, 48)],
             "tiny": [(340, 400, 74), (380, 610, 78), (520, 470, 64)]}[detail]
    for (x, y, r) in chips:
        cr.save(); cr.translate(x, y); cr.scale(1.0, 0.86); cr.rotate(0.5)
        cr.arc(0, 0, r, 0, 2*math.pi); cr.restore(); cr.set_source_rgba(*hexc('#4a2810')); cr.fill()
        if detail == "full":
            cr.arc(x-r*0.3, y-r*0.35, r*0.28, 0, 2*math.pi); cr.set_source_rgba(*hexc('#7a4a24', 0.8)); cr.fill()
    cr.set_operator(cairo.OPERATOR_CLEAR)
    ang = -0.78; bx, by = cx+R*math.cos(ang), cy+R*math.sin(ang)
    for (dx, dy, br) in ([(-0.0, 0, 92), (-62, 96, 64), (70, -90, 64)] if detail != "tiny" else [(0, 0, 120)]):
        cr.arc(bx+dx, by+dy, br, 0, 2*math.pi); cr.fill()
    cr.set_operator(cairo.OPERATOR_OVER)
    cr.pop_group_to_source(); cr.paint()
    if detail == "full":
        for (x, y, r) in [(772, 262, 16), (808, 318, 11), (742, 200, 10)]:
            cr.arc(x, y, r, 0, 2*math.pi); cr.set_source_rgba(*hexc('#d9954d')); cr.fill()
    sw, sh = (420, 470) if detail == "tiny" else (360, 410)
    scx, stop = (740, 520) if detail == "tiny" else (742, 560)
    shield_path(cr, scx, stop, sw, sh); cr.set_source_rgba(*hexc('#141824')); cr.set_line_width(64 if detail == "tiny" else 44); cr.set_line_join(cairo.LINE_JOIN_ROUND); cr.stroke()
    shield_path(cr, scx, stop, sw, sh)
    sg = cairo.LinearGradient(0, stop, 0, stop+sh); sg.add_color_stop_rgba(0, *hexc('#8b8ff9')); sg.add_color_stop_rgba(1, *hexc('#4f46e5'))
    cr.set_source(sg); cr.fill()
    if detail == "full":
        shield_path(cr, scx, stop+16, sw-40, sh-50); cr.set_source_rgba(1, 1, 1, 0.10); cr.set_line_width(6); cr.stroke()
    k = sw/360
    cr.move_to(scx-82*k, stop+sh*0.47); cr.line_to(scx-18*k, stop+sh*0.47+62*k); cr.line_to(scx+92*k, stop+sh*0.47-70*k)
    cr.set_source_rgba(1, 1, 1, 1); cr.set_line_width((62 if detail == "tiny" else 46)*k); cr.set_line_cap(cairo.LINE_CAP_ROUND); cr.set_line_join(cairo.LINE_JOIN_ROUND); cr.stroke()

def png(size, detail, path):
    s = cairo.ImageSurface(cairo.FORMAT_ARGB32, size, size); cr = cairo.Context(s); cr.scale(size/1024, size/1024); draw(cr, detail); s.write_to_png(path)

if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
    os.makedirs(out, exist_ok=True)
    for size in (16, 32, 48, 64, 128, 256, 512):
        png(size, "tiny" if size <= 16 else "mid" if size <= 32 else "full", os.path.join(out, f"cookiegate_{size}.png"))
    svg = cairo.SVGSurface(os.path.join(out, "cookiegate_icon_master.svg"), 1024, 1024); draw(cairo.Context(svg), "full"); svg.finish()
    print("icons written to", out)
