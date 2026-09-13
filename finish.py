#!/usr/bin/env python3
"""
finish.py — pops up a little "let's go" celebration window with confetti.

Standalone, no dependencies beyond the standard library (Tkinter). Meant to
be run manually when a big batch of work wraps up — not part of the MABU
application itself.

Usage:
    python finish.py
"""

import random
import tkinter as tk

WIDTH, HEIGHT = 520, 360
COLORS = ["#00ff66", "#5dffa0", "#35fff0", "#ffb000", "#ff3b5c", "#ffffff"]


class Confetti:
    __slots__ = ("id", "x", "y", "vx", "vy", "spin", "angle", "size")

    def __init__(self, canvas_width):
        self.x = random.uniform(0, canvas_width)
        self.y = random.uniform(-HEIGHT, 0)
        self.vx = random.uniform(-1.5, 1.5)
        self.vy = random.uniform(2, 5)
        self.spin = random.uniform(-8, 8)
        self.angle = random.uniform(0, 360)
        self.size = random.randint(6, 12)
        self.id = None


def main():
    root = tk.Tk()
    root.title("MABU")
    root.configure(bg="#030905")
    root.resizable(False, False)

    # Center on screen
    root.update_idletasks()
    sw, sh = root.winfo_screenwidth(), root.winfo_screenheight()
    x = (sw - WIDTH) // 2
    y = (sh - HEIGHT) // 2
    root.geometry(f"{WIDTH}x{HEIGHT}+{x}+{y}")

    canvas = tk.Canvas(root, width=WIDTH, height=HEIGHT, bg="#030905", highlightthickness=0)
    canvas.pack(fill="both", expand=True)

    canvas.create_text(
        WIDTH // 2, HEIGHT // 2 - 40,
        text="LET'S GO",
        fill="#00ff66",
        font=("Consolas", 40, "bold"),
    )
    canvas.create_text(
        WIDTH // 2, HEIGHT // 2 + 10,
        text="MABU — done.",
        fill="#baffc9",
        font=("Consolas", 14),
    )
    close_btn = tk.Button(
        root, text="close()", command=root.destroy,
        bg="#050f08", fg="#00ff66", activebackground="#0e5c28",
        relief="flat", font=("Consolas", 11), padx=14, pady=6,
    )
    close_btn.place(relx=0.5, rely=0.88, anchor="center")

    pieces = [Confetti(WIDTH) for _ in range(120)]
    for p in pieces:
        color = random.choice(COLORS)
        p.id = canvas.create_rectangle(0, 0, p.size, p.size * 0.6, fill=color, outline="")

    def tick():
        for p in pieces:
            p.x += p.vx
            p.y += p.vy
            p.angle += p.spin
            if p.y > HEIGHT + 20:
                p.y = random.uniform(-40, -10)
                p.x = random.uniform(0, WIDTH)
            canvas.coords(p.id, p.x, p.y, p.x + p.size, p.y + p.size * 0.6)
        root.after(30, tick)

    tick()
    root.attributes("-topmost", True)
    root.after(200, lambda: root.attributes("-topmost", False))
    root.mainloop()


if __name__ == "__main__":
    main()
