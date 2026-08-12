//! Title privacy filter (spec §4): URLs, emails, and file paths are stripped before a title is
//! allowed into any DTO. The raw title never leaves the shell.

use std::sync::OnceLock;

use regex::Regex;

fn patterns() -> &'static [Regex; 4] {
    static PATTERNS: OnceLock<[Regex; 4]> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        [
            // URLs with a scheme, plus bare www hosts.
            Regex::new(r"(?i)\b[a-z][a-z0-9+.-]*://\S+|\bwww\.\S+").expect("url pattern"),
            // Email addresses.
            Regex::new(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b").expect("email pattern"),
            // Windows drive and UNC paths.
            Regex::new(r#"(?:[A-Za-z]:\\|\\\\)[^\s"<>|]*"#).expect("windows path pattern"),
            // Unix-style absolute paths of at least two segments.
            Regex::new(r"(?:^|\s)/(?:[\w.-]+/)+[\w.-]*").expect("unix path pattern"),
        ]
    })
}

pub fn normalize_title(raw: &str) -> String {
    let mut text = raw.to_string();
    for pattern in patterns() {
        text = pattern.replace_all(&text, " ").into_owned();
    }
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_urls_emails_and_file_paths() {
        assert_eq!(
            normalize_title("Docs — https://internal.example.com/secret?q=1 - Browser"),
            "Docs — - Browser",
        );
        assert_eq!(
            normalize_title("Re: invoice from alice@example.com - Mail"),
            "Re: invoice from - Mail",
        );
        assert_eq!(
            normalize_title(r"report.xlsx - C:\Users\denys\Documents\taxes\report.xlsx - Excel"),
            "report.xlsx - - Excel",
        );
        assert_eq!(
            normalize_title("vim /home/denys/notes/passwords.txt"),
            "vim",
        );
        assert_eq!(normalize_title("  SiftKit   -  Visual Studio Code "), "SiftKit - Visual Studio Code");
    }
}
