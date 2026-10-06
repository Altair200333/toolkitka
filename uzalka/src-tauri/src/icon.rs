/// Dynamic 32x32 tray icon: rounded square colored by severity, with the
/// usage percent drawn in a hand-rolled 5x7 pixel font (2x scale).

const W: usize = 32;

#[rustfmt::skip]
const DIGITS: [[u8; 7]; 10] = [
    [0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110], // 0
    [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110], // 1
    [0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111], // 2
    [0b11111, 0b00010, 0b00100, 0b00010, 0b00001, 0b10001, 0b01110], // 3
    [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010], // 4
    [0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110], // 5
    [0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110], // 6
    [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000], // 7
    [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110], // 8
    [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100], // 9
];

const EXCLAIM: [u8; 7] = [0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00000, 0b00100];

fn fill_rounded(buf: &mut [u8], color: [u8; 3]) {
    let r = 7.0_f32;
    for y in 0..W {
        for x in 0..W {
            let (fx, fy) = (x as f32 + 0.5, y as f32 + 0.5);
            let cx = fx.clamp(r, W as f32 - r);
            let cy = fy.clamp(r, W as f32 - r);
            let d = ((fx - cx).powi(2) + (fy - cy).powi(2)).sqrt();
            let a = (1.0 - (d - r + 0.5).clamp(0.0, 1.0)) * 255.0;
            let i = (y * W + x) * 4;
            buf[i] = color[0];
            buf[i + 1] = color[1];
            buf[i + 2] = color[2];
            buf[i + 3] = a as u8;
        }
    }
}

fn draw_glyph(buf: &mut [u8], glyph: &[u8; 7], ox: usize, oy: usize, scale: usize) {
    for (row, bits) in glyph.iter().enumerate() {
        for col in 0..5 {
            if bits & (1 << (4 - col)) != 0 {
                for dy in 0..scale {
                    for dx in 0..scale {
                        let x = ox + col * scale + dx;
                        let y = oy + row * scale + dy;
                        if x < W && y < W {
                            let i = (y * W + x) * 4;
                            buf[i] = 255;
                            buf[i + 1] = 255;
                            buf[i + 2] = 255;
                            buf[i + 3] = 255;
                        }
                    }
                }
            }
        }
    }
}

/// percent: None => error state ("!")
pub fn render(percent: Option<f64>) -> Vec<u8> {
    let mut buf = vec![0u8; W * W * 4];
    let color = match percent {
        None => [110, 118, 129],
        Some(p) if p >= 90.0 => [225, 78, 70],
        Some(p) if p >= 70.0 => [227, 152, 43],
        Some(_) => [39, 148, 86],
    };
    fill_rounded(&mut buf, color);

    let scale = 2;
    let gw = 5 * scale; // glyph width 10
    let gh = 7 * scale; // glyph height 14
    let oy = (W - gh) / 2;

    match percent {
        None => draw_glyph(&mut buf, &EXCLAIM, (W - gw) / 2, oy, scale),
        Some(p) => {
            let p = (p.round().max(0.0) as usize).min(99);
            if p < 10 {
                draw_glyph(&mut buf, &DIGITS[p], (W - gw) / 2, oy, scale);
            } else {
                let gap = 2;
                let total = gw * 2 + gap;
                let ox = (W - total) / 2;
                draw_glyph(&mut buf, &DIGITS[p / 10], ox, oy, scale);
                draw_glyph(&mut buf, &DIGITS[p % 10], ox + gw + gap, oy, scale);
            }
        }
    }
    buf
}
