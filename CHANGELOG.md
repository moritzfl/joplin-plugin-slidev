# Slidev Presentation Changelog

## [Unreleased]

## [0.2.4] - 2026-05-13
- Fixed PDF export filenames with spaces or shell metacharacters on Windows
- Redacted remote presentation passwords from Slidev logs
- Fixed overflowing slide content disappearing from exported PDFs

## [0.2.3] - 2026-05-12
- Fixed local resources failing to resolve from Slidev virtual slide modules

## [0.2.2] - 2026-05-12
- Fixed attachment resources failing to load with current Slidev/Vite versions on Windows

## [0.2.1] - 2026-05-06
- Fixed layout issues caused by empty fenced code blocks and resource references inside code blocks
- Fixed the package search field not being clearable
- Fixed changes to the npm path setting requiring a Joplin restart to take effect
- Fixed leftover Slidev processes not being cleaned up, blocking the port for subsequent presentations
- Improved theme and add-on store load responsiveness

## [0.2.0] - 2026-05-06
- Added configurable slide number positions via the `Slide number` setting and `slideNumber` frontmatter key
- Added configurable progress bar positions via the `Progress bar` setting and `slideProgressBar` frontmatter key
- Replaced the previous combined `slideProgress` option with separate slide number and progress bar controls

## [0.1.4] - 2026-05-04
- Fixed Slidev process not being fully terminated on Windows after closing the presentation, leaving the port blocked for subsequent presentations — now uses `taskkill /F /T` to kill the entire process tree

## [0.1.3] - 2026-05-04
- Fixed "spawn npm ENOENT" error on Windows by using `npm.cmd` and `shell: true` for npm invocations, and by adding common Windows npm locations (`%APPDATA%\npm`, `C:\Program Files\nodejs`) to the child process PATH
- Added an advanced "npm executable path" setting to manually specify the npm binary when auto-detection fails

## [0.1.2] - 2026-05-03
- Added a tunnel entry button when Slidev reports a Cloudflare tunnel URL
- Added restricted Vite dev-server host allowance for Cloudflare Quick Tunnel URLs
- Added an advanced presenter-controlled navigation option that locks the public slide view

## [0.1.1] - 2026-05-03
- Added Slidev remote access settings for `--remote`, `--remote=<password>`, `--tunnel`, and `--bind`
- Added an advanced informational workspace path setting that is easy to copy and resets if edited
- Renamed the managed Slidev workspace directory from `slidev-tmp` to `slidev-workspace`
