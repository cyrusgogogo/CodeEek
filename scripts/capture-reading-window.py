"""Capture only a foreground, visible DSH window; never reads cookies or credentials."""
import ctypes
from ctypes import wintypes
from pathlib import Path
import sys
from PIL import ImageGrab

hwnd = int(sys.argv[1])
user = ctypes.windll.user32
user.SetForegroundWindow.argtypes = [wintypes.HWND]
user.GetForegroundWindow.restype = wintypes.HWND
try:
    user.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
except (AttributeError, OSError):
    pass
user.SetForegroundWindow(hwnd)
ctypes.windll.dwmapi.DwmFlush()
if user.GetForegroundWindow() != hwnd:
    raise RuntimeError('DSH is not foreground; refusing to capture another application')
rectangle = wintypes.RECT()
result = ctypes.windll.dwmapi.DwmGetWindowAttribute(wintypes.HWND(hwnd), 9, ctypes.byref(rectangle), ctypes.sizeof(rectangle))
if result:
    raise RuntimeError(f'Cannot read DSH window bounds: {result}')
output = Path('.test-output/live/reading-real.png')
output.parent.mkdir(parents=True, exist_ok=True)
ImageGrab.grab(bbox=(rectangle.left, rectangle.top, rectangle.right, rectangle.bottom), all_screens=True).save(output)
print(output.resolve())
