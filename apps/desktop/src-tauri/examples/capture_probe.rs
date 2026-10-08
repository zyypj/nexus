//! Lists the capture sources the share picker would show and captures the
//! first screen for 3 s at a few targets (no UI, no WebView):
//! `cargo run --release --example capture_probe [out_dir] [window title]`
//! (writes thumbnails and one captured frame per target as JPEG).
fn main() {
    let out = std::env::args().nth(1);
    let start = std::time::Instant::now();
    let sources = nexus_desktop_lib::screen_capture::probe_sources().expect("list sources");
    println!("{} sources in {:?}", sources.len(), start.elapsed());
    for (i, s) in sources.iter().enumerate() {
        let thumb = s.thumbnail.as_deref().unwrap_or("");
        println!(
            "{:>2} {:6} {:>5}x{:<5} pid={:<6} app={:<20} thumb={:>6}B  {}",
            i,
            s.kind,
            s.width,
            s.height,
            s.pid.unwrap_or(0),
            s.app.as_deref().unwrap_or("-"),
            thumb.len(),
            s.name
        );
        if let (Some(dir), Some(b64)) = (&out, thumb.strip_prefix("data:image/jpeg;base64,")) {
            use base64::Engine;
            let bytes = base64::engine::general_purpose::STANDARD.decode(b64).unwrap();
            std::fs::write(format!("{dir}/{i:02}-{}.jpg", s.kind), bytes).unwrap();
        }
    }

    // Optional 2nd argument: capture the window whose title contains it.
    let screen = match std::env::args().nth(2) {
        Some(title) => &sources.iter().find(|s| s.name.contains(&title)).expect("window").id,
        None => &sources.iter().find(|s| s.kind == "screen").expect("a screen").id,
    };
    for (fps, mw, mh) in [(30, 1280, 720), (60, 1920, 1080), (30, 640, 360)] {
        let target = nexus_desktop_lib::screen_capture::CaptureTarget {
            fps,
            max_width: mw,
            max_height: mh,
        };
        let r = nexus_desktop_lib::screen_capture::probe_capture(screen, target, 3).expect("capture");
        let (frames, w, h, px) = (r.frames, r.width, r.height, r.pixels);
        println!(
            "target {mw}x{mh}@{fps}: {frames} frames in 3 s ({:.1} fps), output {w}x{h}",
            frames as f32 / 3.0
        );
        if let (Some(dir), Some(px)) = (&out, px) {
            let mut jpeg = Vec::new();
            jpeg_encoder::Encoder::new(&mut jpeg, 80)
                .encode(&px, w as u16, h as u16, jpeg_encoder::ColorType::Bgra)
                .unwrap();
            std::fs::write(format!("{dir}/frame-{mw}x{mh}.jpg"), jpeg).unwrap();
        }
    }
}
