# Visual refinement and instructor score panel

- Increased contrast in the mode-selection modal: descriptions are white on dark, high-contrast mode cards in both light and dark themes.
- Made player nicknames readable in the lobby participant chips displayed beside the QR code in the light theme; dark theme has an explicit matching style.
- Matched the quiz title field to the editor's question/answer field appearance and normalized text-field padding to `12px 14px` across the editor, including the default-time control.
- Reworked the instructor live overview to focus on total points, current-question points after a round, correct/answered counts, and the current points leader. In Color Kingdoms it instead emphasizes flags, captured tiles, correctness, and the flag leader.
- Added English and Chinese translations for the new score and flag metrics.
- Bumped the Liquid Glass stylesheet query version to `v=5` to avoid stale browser cache.
