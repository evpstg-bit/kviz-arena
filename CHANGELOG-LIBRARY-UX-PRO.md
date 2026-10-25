# Library UX — Professional flow

- Removed the game-mode modal that appeared after pressing Launch. The mode is selected in the library toolbar before the game starts and saved locally as `kviz-launch-mode`.
- Quiz cards use icon-only Launch, Edit and Copy actions with `title` and `aria-label` attributes for tooltips and assistive technologies.
- The active folder header provides a primary **Create quiz** action. Creating a quiz from inside a subject folder preselects that folder and saves it with the new quiz.
- Added the `lib/create` server operation with validation and folder existence checks; new quizzes are committed through the existing built-in library mutation/sync path.
- Removed stale UI translation entries that referred to the deleted post-launch mode dialog and outdated empty-folder instruction.
- Reduced duplicate navigation: the dashboard has one root navigation component for Library / Reports; folder-specific rename/delete actions remain in the folder tree; Import/Export remain in the library toolbar.
- The editor save button reads **Create quiz** for new quizzes and **Save changes** when editing an existing quiz.
- Updated README and usage instructions; project version bumped to 1.5.0.
