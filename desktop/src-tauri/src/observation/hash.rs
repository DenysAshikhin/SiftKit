//! Capture hashing (spec §4): SHA-256 over the encoded PNG bytes, and a 64-bit dHash over the
//! pixels. Rust computes bytes and hashes only; every dedupe *decision* is the daemon's.

use sha2::{Digest, Sha256};

use crate::platform::CaptureFrame;

pub fn pixel_sha256(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut hex = String::with_capacity(64);
    for byte in digest {
        hex.push_str(&format!("{byte:02x}"));
    }
    hex
}

/// dHash over a 9×8 grayscale reduction: bit set where the left pixel is brighter-or-equal
/// than its right neighbour, row-major from the most significant bit.
pub fn dhash64_from_gray(gray: &[u8; 72]) -> u64 {
    let mut hash = 0u64;
    for row in 0..8 {
        for column in 0..8 {
            hash <<= 1;
            if gray[row * 9 + column] < gray[row * 9 + column + 1] {
                hash |= 1;
            }
        }
    }
    hash
}

pub fn dhash64_hex(frame: &CaptureFrame) -> String {
    format!("{:016x}", dhash64_from_gray(&downscale_gray_9x8(frame)))
}

/// Box-average downscale of an RGBA frame to the 9×8 grayscale grid dHash compares.
fn downscale_gray_9x8(frame: &CaptureFrame) -> [u8; 72] {
    let mut gray = [0u8; 72];
    if frame.width == 0 || frame.height == 0 {
        return gray;
    }
    for (cell, value) in gray.iter_mut().enumerate() {
        let cell_x = (cell % 9) as u64;
        let cell_y = (cell / 9) as u64;
        let x_start = cell_x * u64::from(frame.width) / 9;
        let x_end = ((cell_x + 1) * u64::from(frame.width) / 9).max(x_start + 1);
        let y_start = cell_y * u64::from(frame.height) / 8;
        let y_end = ((cell_y + 1) * u64::from(frame.height) / 8).max(y_start + 1);
        let mut total = 0u64;
        let mut samples = 0u64;
        for y in y_start..y_end.min(u64::from(frame.height)) {
            for x in x_start..x_end.min(u64::from(frame.width)) {
                let offset = ((y * u64::from(frame.width) + x) * 4) as usize;
                let r = u64::from(frame.rgba[offset]);
                let g = u64::from(frame.rgba[offset + 1]);
                let b = u64::from(frame.rgba[offset + 2]);
                // ITU-R BT.601 luma, integer form.
                total += (299 * r + 587 * g + 114 * b) / 1000;
                samples += 1;
            }
        }
        *value = if samples == 0 { 0 } else { (total / samples) as u8 };
    }
    gray
}

/// DRM-protected surfaces come back as a uniform frame; that is a capture failure, never
/// evidence (spec §7).
pub fn is_blank_frame(frame: &CaptureFrame) -> bool {
    match frame.rgba.chunks_exact(4).next() {
        None => true,
        Some(first) => frame
            .rgba
            .chunks_exact(4)
            .all(|pixel| pixel[0] == first[0] && pixel[1] == first[1] && pixel[2] == first[2]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_matches_the_known_vector() {
        assert_eq!(
            pixel_sha256(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        );
    }

    #[test]
    fn dhash_of_known_gradients_is_deterministic() {
        let mut ascending = [0u8; 72];
        for (index, value) in ascending.iter_mut().enumerate() {
            *value = ((index % 9) * 20) as u8;
        }
        assert_eq!(dhash64_from_gray(&ascending), u64::MAX, "left < right everywhere");

        let mut descending = [0u8; 72];
        for (index, value) in descending.iter_mut().enumerate() {
            *value = 200 - ((index % 9) * 20) as u8;
        }
        assert_eq!(dhash64_from_gray(&descending), 0, "left > right everywhere");
    }

    #[test]
    fn identical_frames_hash_identically() {
        let frame = CaptureFrame {
            width: 18,
            height: 16,
            rgba: (0..18u32 * 16 * 4).map(|index| (index % 251) as u8).collect(),
        };
        let twin = frame.clone();
        assert_eq!(dhash64_hex(&frame), dhash64_hex(&twin));
        assert_eq!(dhash64_hex(&frame).len(), 16);
    }

    #[test]
    fn a_uniform_frame_is_blank() {
        let black = CaptureFrame { width: 4, height: 4, rgba: vec![0u8; 64] };
        assert!(is_blank_frame(&black));
        let mut lit = black.clone();
        lit.rgba[20] = 255;
        assert!(!is_blank_frame(&lit));
    }
}
