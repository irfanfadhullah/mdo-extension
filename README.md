# MDO Markdown Object Downloader for Chrome and Viewer for VS Code Extension

This extension reads and writes `.mdo` files.

`.mdo` is a single-file ZIP-based Markdown Object format:

```text
note.mdo
├── manifest.json
├── metadata.json
├── document.md
├── assets/
│   ├── image.png
│   ├── animation.gif
│   ├── demo.mp4
│   └── voice.mp3
└── attachments/
    ├── paper.pdf
    └── data.csv
```

## Features

- Open `.mdo` as the default custom VS Code editor.
- Edit Markdown directly inside the `.mdo` editor.
- Render Markdown.
- Show images and GIF.
- Play video/audio using HTML `<video>` and `<audio>`.
- Drag media files into the editor and save them into the archive.
- Create a blank `.mdo` file from the Command Palette.
- Import `.md` into `.mdo` when you want to convert an existing Markdown file.
- Extract `.mdo` to a normal folder.
- Capture the current browser tab into `.mdo` from the Chrome extension.
- Store machine-readable alignment metadata in `metadata.json` for search, wiki indexing, and LLM/VLM training.

## Installation

This repository currently ships a desktop VS Code extension. The same `.vsix` package installs on Ubuntu, Windows, and macOS.

| Target | Status | Install path |
| --- | --- | --- |
| Ubuntu | Supported | Install the generated `.vsix` in desktop VS Code |
| Windows | Supported | Install the generated `.vsix` in desktop VS Code |
| macOS | Supported | Install the generated `.vsix` in desktop VS Code |
| VS Code extension | Supported | This is the native target for this repository |
| VS Code Web | Not supported yet | Needs a browser-compatible build and different file-system handling |
| Chrome extension | Experimental | Load the unpacked `chrome/` folder after running `npm run chrome:build` |

### Install from source

```bash
npm install
npm run package-vsix
code --install-extension mdo-vscode-0.0.1.vsix
```

You can also install the generated `.vsix` from the VS Code UI with `Extensions` > `...` > `Install from VSIX...`.

## Run in development

Open this folder in VS Code, then press:

```text
F5
```

A new Extension Development Host window will open.

## Build

```bash
npm run package
```

## Package as VSIX

```bash
npm run package-vsix
```

Then install the generated `.vsix` in VS Code.

## Usage

### Create MDO

Use `MDO: New Editable MDO` from the Command Palette to create a blank `.mdo` file.

```text
MDO: New Editable MDO
```

Then drag media files into the editor, edit the Markdown, and save.

To import an existing Markdown file, right-click a `.md` file and run:

```text
MDO: Import Markdown into MDO
```

### Preview MDO

Open a `.mdo` file directly.

### Capture from Chrome

Build the browser bundle:

```bash
npm run chrome:build
```

Then open `chrome://extensions`, enable Developer mode, and load the unpacked `chrome/` folder.

Use the extension button to capture the active tab:

- Web pages are captured as Markdown inside `document.md`.
- Images, video, audio, and downloadable attachments are fetched into the archive and linked from the Markdown.
- PDF tabs are converted into Markdown with extracted page text plus page images, and the original PDF is kept as an attachment inside the `.mdo`.
- `manifest.json` stays the package index, and `metadata.json` carries the block/media graph for downstream training or research indexing.

### Extract MDO

Right-click a `.mdo` file:

```text
MDO: Extract MDO
```

## Markdown media examples

```md
# My MDO Note

Image: `result.png`

GIF: `animation.gif`

Video demo: `demo.mp4`

Audio note: `voice.mp3`

Paper: `paper.pdf`
```

Video/audio Markdown links are converted to playable media blocks in the preview.
