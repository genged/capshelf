---
name: Capshelf
description: The Capshelf product web UI. A code-review workspace on white paper with hairline borders, green for chosen and current, orange for attention.
colors:
  bg: "#ffffff"
  bg-rail: "#f6f8fa"
  bg-hover: "#f0f3f6"
  line: "#d0d7de"
  line-soft: "#e6eaef"
  ink: "#1f2328"
  ink-2: "#57606a"
  ink-3: "#6e7781"
  scrim: "rgba(31, 35, 40, 0.35)"
  green: "#0d502b"
  green-soft: "#e6f2ea"
  green-line: "#b9d8c5"
  orange: "#ff9300"
  orange-ink: "#9c4a00"
  orange-soft: "#fff1dc"
  orange-line: "#ffd49a"
  add-bg: "#e3f6e8"
  add-bg-no: "#cdeed6"
  del-bg: "#fdeae8"
  del-bg-no: "#f9d4cf"
  del-ink: "#8a1c0f"
  syntax-keyword: "#7a2d8f"
  syntax-string: "#0b5f3b"
  syntax-number: "#8a4a00"
  syntax-name: "#0b4f8a"
typography:
  display:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace"
    fontSize: "22px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.01em"
  headline:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans', sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.3
  title:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: 1.45
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans', sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.45
  body-small:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans', sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.45
  caption:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans', sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans', sans-serif"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "0.06em"
  code:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  sm: "4px"
  md: "6px"
  lg: "8px"
  pill: "999px"
spacing:
  "2": "2px"
  "4": "4px"
  "6": "6px"
  "8": "8px"
  "10": "10px"
  "12": "12px"
  "14": "14px"
  "16": "16px"
  "20": "20px"
  "24": "24px"
  "32": "32px"
  "48": "48px"
components:
  top-bar:
    backgroundColor: "{colors.bg}"
    height: "56px"
    padding: "0 16px"
  tree-rail:
    backgroundColor: "{colors.bg-rail}"
    width: "280px"
    padding: "14px 10px 24px"
  side-rail:
    width: "300px"
    padding: "20px 16px 32px"
  button:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "5px 10px"
  button-hover:
    backgroundColor: "{colors.bg-hover}"
  button-disabled:
    backgroundColor: "{colors.bg-rail}"
    textColor: "{colors.ink-3}"
  icon-button:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    size: "32px"
  copy-button:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "4px 8px"
  copy-button-copied:
    backgroundColor: "{colors.green-soft}"
    textColor: "{colors.green}"
  copy-button-failed:
    backgroundColor: "{colors.orange-soft}"
    textColor: "{colors.orange-ink}"
  link:
    textColor: "{colors.green}"
  chip:
    backgroundColor: "{colors.bg-rail}"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.pill}"
    padding: "0 6px"
    height: "18px"
  count-ok:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.pill}"
    padding: "0 7px"
    height: "18px"
  count-attention:
    backgroundColor: "{colors.orange-soft}"
    textColor: "{colors.orange-ink}"
    rounded: "{rounded.pill}"
    padding: "0 7px"
    height: "18px"
  tab:
    backgroundColor: "transparent"
    textColor: "{colors.ink-2}"
    rounded: "0"
    padding: "8px 12px"
  tab-hover:
    backgroundColor: "{colors.bg-hover}"
    textColor: "{colors.ink}"
  tab-active:
    textColor: "{colors.ink}"
  segmented:
    backgroundColor: "{colors.bg-rail}"
    rounded: "{rounded.md}"
    padding: "2px"
  segmented-option:
    backgroundColor: "transparent"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.md}"
    padding: "3px 12px"
  segmented-option-active:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.ink}"
  filter:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "34px"
    width: "300px"
  tree-row:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "4px 8px"
    height: "32px"
  tree-row-hover:
    backgroundColor: "{colors.bg-hover}"
  tree-row-selected:
    backgroundColor: "{colors.green-soft}"
    textColor: "{colors.green}"
  shelf-row:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "6px 8px"
  shelf-row-selected:
    backgroundColor: "{colors.green-soft}"
  panel:
    backgroundColor: "{colors.bg}"
    rounded: "{rounded.lg}"
    padding: "8px 12px"
  panel-body:
    padding: "12px 12px 14px"
  card:
    backgroundColor: "{colors.bg}"
    rounded: "{rounded.lg}"
    padding: "12px 14px"
  command-row:
    backgroundColor: "{colors.bg-rail}"
    typography: "{typography.code}"
    rounded: "{rounded.md}"
    padding: "8px 10px"
  notice:
    backgroundColor: "{colors.bg-rail}"
    rounded: "{rounded.md}"
    padding: "10px 12px"
  notice-warn:
    backgroundColor: "{colors.orange-soft}"
  all-clear:
    backgroundColor: "{colors.green-soft}"
    textColor: "{colors.green}"
    rounded: "{rounded.md}"
    padding: "10px 12px"
  code-inline:
    backgroundColor: "{colors.bg-rail}"
    rounded: "{rounded.sm}"
    padding: "0.05em 0.35em"
  kbd:
    backgroundColor: "{colors.bg-rail}"
    rounded: "{rounded.sm}"
    padding: "1px 6px"
  diff-add:
    backgroundColor: "{colors.add-bg}"
  diff-add-gutter:
    backgroundColor: "{colors.add-bg-no}"
    textColor: "{colors.green}"
  diff-del:
    backgroundColor: "{colors.del-bg}"
  diff-del-gutter:
    backgroundColor: "{colors.del-bg-no}"
    textColor: "{colors.del-ink}"
  key-help:
    backgroundColor: "{colors.bg}"
    rounded: "{rounded.lg}"
    padding: "12px 14px"
    width: "380px"
---

# Design System: Capshelf

## Overview

**Creative North Star: "The Review Workspace"**

This document records the product web UI, the dashboard that `capshelf ui` serves. It describes the built code under `src/ui/client/`, not a plan. PRODUCT.md leaves open whether the public website shares this system. This document does not decide that. Line citations name `src/ui/client/styles.css` unless another file is named.

The surface borrows the grammar of a code-review tool. A project tree sits on the left. The project sits in the center as reviewable panels. The exact commands sit on the right. The ground is white paper. Structure comes from one-pixel hairlines and one tinted rail, never from shadows or gradients. Two accents carry all meaning. Green says chosen and current. Orange says look here. Every path, ref, digest, and command sets in monospace. The page title is one of those identifiers.

Density is high and even. Body text is 14px. Most secondary text is 13px. Nothing in the chrome is larger than 22px. Motion is short and functional. A chevron turns, a panel body fades in, and a changed panel flashes orange once. The build refuses the metric-tile dashboard. There are no stat cards, no charts, and no hero.

**Key Characteristics:**
- White ground, hairline structure, one tinted rail for lists.
- Two accents with fixed meaning: green for selection and up to date, orange for attention.
- System sans for prose. System monospace for every identifier, including titles.
- Flat depth. Borders darken to show state. Nothing casts a shadow.
- Attention first. Trees, panels, and actions sort by what needs work.
- Every action is a printed command with a copy button. The UI is read-only.

## Colors

The palette is a set of cool neutrals with the two brand colors from `docs/logo.png` as the only accents.

### Primary
- **Shelf Green** (`green`): the brand green from the mark. It marks the selected tree row and shelf row (571-576, 1418-1421), the up-to-date badge and its check icon (250-252), the active tab bar (774-778), links (193-202, 1619-1621), the focused filter border (403-406), and the focus ring (65-68). Inside a diff it is the gutter ink of an added line (1077-1080). The stylesheet defines `--green`, `--green-ink`, and `--focus` at this one value (14-15, 27).
- **Green Wash** (`green-soft`): the fill behind a selected row, the all-clear banner (713-723), a copied button (275-279), and text selection (60-63).
- **Green Hairline** (`green-line`): the border of every Green Wash element.

### Secondary
- **Pin Orange** (`orange`): the brand orange from the mark. It is an icon stroke and a momentary border, never text. Alert triangles (245-248, 617-620, 739-742), warning bullets (946-948, 1473-1475), and the first frame of the changed-panel flash (825-829) use it.
- **Orange Ink** (`orange-ink`): the text beside a Pin Orange icon. The state badges "Update available" and "Drifted", attention counts, the uncommitted-changes note in the top bar, and a failed comparison use it (123-125, 241-243, 360-362).
- **Orange Wash** (`orange-soft`) and **Orange Hairline** (`orange-line`): the attention count pill (606-610), the warning notice (734-737), a failed copy button (281-285), and the changed-panel flash.

### Tertiary
These colors appear only inside a diff table or a code block.
- **Add Wash** (`add-bg`) and **Add Gutter** (`add-bg-no`): the background of an added line and its number cell (1077-1084).
- **Delete Wash** (`del-bg`) and **Delete Gutter** (`del-bg-no`): the background of a removed line and its number cell (1091-1098).
- **Delete Ink** (`del-ink`): the number and marker of a removed line, deleted tokens, and syntax errors (1091-1094, 1100-1103, 1172-1175). The stylesheet writes this value as a literal. The token name is this document's.
- **Syntax Keyword, Syntax String, Syntax Number, Syntax Name** (`syntax-keyword`, `syntax-string`, `syntax-number`, `syntax-name`): the quiet highlighter set (1139-1162). Comments use Ink 3 in italic. Operators use Ink 2. These four values are also literals in the stylesheet.

### Neutral
- **Paper** (`bg`): the page, panels, cards, controls, and the diff table body.
- **Rail** (`bg-rail`): the tree rail, the shelf list, inline code, command rows, segmented-control tracks, diff file heads, hunk rows, and empty diff cells.
- **Hover** (`bg-hover`): the hover fill of every row, button, and tab (171-176, 554-556).
- **Hairline** (`line`): every structural border, the scrollbar thumb, and the rail edge.
- **Soft Hairline** (`line-soft`): inner dividers, the open panel's head divider, inline code borders, and skeleton fills.
- **Ink** (`ink`): primary text.
- **Ink 2** (`ink-2`): secondary text, labels, and muted notes. The `kept` tone for kept-local items uses this same value (22, 127-129).
- **Ink 3** (`ink-3`): placeholders, chevrons, line numbers, disabled text, and the open panel's border (817-819).
- **Scrim** (`scrim`): Ink at 35 percent behind the mobile tree drawer (1837-1845).

### Named Rules
**The Orange Stroke Rule.** Pure Pin Orange is an icon stroke or a one-second border. It is never the color of a word. Words beside an orange icon use Orange Ink (119-125, 245-248).

**The Two Washes Rule.** Outside a diff table, only Green Wash and Orange Wash may fill an element. They state selection, success, or attention. The direction contract said tints stay inside diffs. The build uses these two washes on rows, banners, pills, and notices, so the build's rule is recorded here.

**The Three Tones Rule.** An item's state is green (ok), orange (attention), or Ink 2 (kept). No fourth status color exists (119-129).

## Typography

**Display Font:** system monospace stack (`ui-monospace`, with SFMono-Regular, Menlo, Consolas, and Liberation Mono)
**Body Font:** system sans stack (`-apple-system`, with BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, and Noto Sans)
**Label/Mono Font:** the same monospace stack

**Character:** No webfont ships. The direction contract chose the system's own faces. The monospace face carries the identity because every title is an identifier, a project path or an item ref. Numbers are tabular everywhere (57). Headings balance their line breaks (93).

### Hierarchy
- **Display** (600, 22px, 1.3, -0.01em, monospace): the page title. The project path in the review head (697-702). It drops to 18px under 800px (1857-1859).
- **Headline** (600, 15px, 1.3, sans): the card heads "Actions" and "Shelf revisions" (1224-1226), external sections (1188-1190), and the review summary line in Ink 2 at 400 (704-707). The rendered markdown reader uses 18px for its h2 and 15px for its h3 (1577-1587).
- **Title** (600, 14px, monospace): the item ref in a panel head (877-881), a shelf row ref (1423-1428), and a diff file path (1009-1011).
- **Body** (400, 14px, 1.45, sans): panel prose, notices, and empty states (50-58). Rendered markdown uses 1.55 and a 72ch measure (1568-1575).
- **Body Small** (400, 13px, sans): facts, meta lines, tree items, revisions, diff file heads, card leads, and key help.
- **Caption** (400, 12px, sans): the refresh time, command purpose, card foot, pin digests, and shelf row detail. Diff column heads use this size at 600 (1022-1031).
- **Label** (600, 12px, 0.06em, uppercase, Ink 2): rail group heads only. "Projects" in the tree uses it (515-520). The kind groups in the shelf list use it at 11px (1391-1397). Chips and count pills are 11px at 500 or 600 (213-226, 590-604).
- **Code** (400, 12.5px, 1.5, monospace): diff tables, commands, code blocks, and frontmatter (1013-1020, 1272-1280, 1554-1564). Inline code is 0.93em of its parent (100-106).

### Named Rules
**The Identifier Rule.** A path, ref, digest, commit, command, or file name sets in monospace, even when it is the page title. Prose never does.

**The Flat Ramp Rule.** Chrome text runs from 11px to 22px. Only the page title exceeds 15px. Emphasis comes from weight (500, 600, 700) and from Ink 2, not from size.

**The Group Head Rule.** Uppercase tracked text is a group head inside a rail list. It never sits above a title as an eyebrow.

## Layout

The status view is a three-column grid: a 280px tree, a fluid center, and a 300px side rail (458-464). A 56px top bar is sticky (299-310). Both rails are sticky under it and scroll on their own (466-473, 480-489). The center pads 20px at the top, 24px at the sides, and 48px at the bottom (475-478). Its content stops at 1200px (680-685). Panels stack with a 10px gap (798-802). Cards in the side rail stack with a 16px gap (488).

The shelf view is a two-column grid: a list between 300px and 420px wide, and a reader that stops at 860px (1322-1327, 1482-1487). Rendered markdown stops at 72ch (1572).

Order is attention first. The tree sorts projects by attention. Panels sort attention first. The first attention panel with a diff opens on its own, once per project (`dashboard.tsx:242-271`). The side rail lists only items that have a command (`ActionsCard.tsx:19-21`).

Spacing is an even-pixel ladder, not a strict 4px or 8px grid. Gaps of 2, 4, 6, 8, 10, 12, 14, and 16px all appear. Padding of 20, 24, 32, and 48px frames the columns. Values of 3px and 5px appear inside controls and are not rhythm steps. A project row is at least 32px tall and an item row at least 28px (537-543, 649-653). A panel head is at least 44px (842-849).

Breakpoints:
- **Up to 1100px** (1754-1776): the side rail drops under the review as an auto-fit grid of 300px cards. The refresh time hides.
- **Up to 800px** (1778-1893): the top bar is 52px. The tree becomes a fixed drawer, 280px or 86vw, over a scrim. The brand name and the context line hide. The filter fills the bar. Facts stack in one column. The side-by-side diff becomes a unified column and the three-way mode hides (`DiffView.tsx:28-40`, `DiffView.tsx:61`). The shelf list stacks above the reader and stops at 50vh.

**The Attention First Rule.** Every list sorts what needs work to the top. The first finding is open before the reader clicks.

## Elevation & Depth

Nothing casts a shadow and nothing is a gradient. Depth is tonal and linear. The rails sit on Rail gray. Panels, cards, and controls sit on Paper with a Hairline border. Command rows and code sit on Rail inside a Paper card. State changes a border, not a shadow. The open panel's border darkens from Hairline to Ink 3 (817-819). The keyboard help dialog floats with an Ink 3 border and no shadow (1700-1710). The stacking order is the sticky bar at 20, the drawer scrim at 24, the drawer at 25, and the key help at 30.

### Named Rules
**The No Shadow Rule.** A surface that must read as raised gets a darker border or a Rail fill. It never gets a shadow, a blur, or a gradient.

**The Border Darkens Rule.** Focus and open states move the border one step up the neutral ramp, Hairline to Ink 3. Selection moves it to Green Hairline.

## Shapes

Corners are small and consistent. Inline code and key caps use 4px (108-113, 1742-1750). Buttons, inputs, rows, tabs, diff files, notices, and command rows use 6px (`--radius`, 33). Panels, cards, and the help dialog use 8px (`--radius-lg`, 34). Chips and count pills are full pills (213-226, 590-604). Underline tabs are square with a 2px bottom bar (757-778). Rows carry a transparent 1px border at rest so a selection border does not shift layout (548, 1409). Segmented controls are a 2px inset track with the active option lifted to Paper (364-387, 958-982). A key cap has a 2px bottom border (1747). Icons are 16px, drawn with one 1.6px stroke, round caps and joins (`icons.tsx:41-50`). An icon always has a word: visible text beside it, or an accessible label on an icon-only button (`icons.tsx:52-80`).

## Components

### Buttons
Buttons are quiet. They are Paper with a Hairline border and read as controls by shape, not by color.
- **Shape:** 6px corners, 1px Hairline border (145-161).
- **Default:** Paper fill, Ink text, 500 weight, 5px 10px padding, 6px icon gap (163-169). Hover fills with Hover gray over 150ms (171-176). Disabled shows Ink 3 text on Rail (178-182).
- **Icon button:** a 32px square with the same border (184-191).
- **Copy button:** 12px text at 500, 4px 8px padding, and a copy icon. Copied turns Green Wash with a check icon for 1.6 seconds. Failed turns Orange Wash (258-289, `common.tsx:8-53`). The compact form shows the icon only.
- **Link button:** no border, Shelf Green text, a 2px underline offset (193-202).
- **Focus:** a 2px Shelf Green outline, offset 2px, on every control (65-68).
- **Primary action:** there is no filled primary button. The first copy button in the Actions card is the primary action.

### Chips
- **Style:** 11px, 500 weight, 18px tall pill, Rail fill, Hairline border, Ink 2 text (213-226).
- **Variants:** `local`, `system`, and `#tag` share one style. Tags sit with a 4px right gap (228-231).
- **Count pill:** 11px at 600, Paper fill, Hairline border, an icon and a number. All up to date shows a green check. Attention shows an orange triangle on Orange Wash with Orange Ink text (590-620). Missing and error read as attention.

### State Badge
- **Style:** 600 weight, an icon and a word (233-239). A green check for ok. An orange triangle, pencil, or not-equal sign with Orange Ink text for attention. Ink 2 for kept.

### Tabs
- **Underline tabs:** 500 weight, Ink 2, 8px 12px padding, a transparent 2px bottom bar. Active is Ink at 600 with a Shelf Green bar. A count pill follows the label (751-796). File tabs in the shelf reader set in Code (1549-1552).
- **Segmented control:** a Rail track with 2px padding. Options are 3px 12px in Ink 2. The active option lifts to Paper with a Hairline border (364-387, 958-982). It switches Status and Shelf, and Installed, Shelf, and Three-way.

### Cards / Containers
- **Corner Style:** 8px for panels and cards, 6px for rows inside them.
- **Item panel:** Paper, Hairline border. The head is a full-width toggle with a chevron, the ref in Title, a pin digest in Caption, and a state badge at the right (838-891). Open turns the border Ink 3, divides the head with Soft Hairline, and reveals the body over 220ms (817-819, 863-866, 898-915). A panel whose state changed since the last refresh flashes Orange Wash for 2.6 seconds (821-836).
- **Side card:** Hairline border, 12px 14px padding, 10px gap. The head is Headline. The foot is Caption over a Soft Hairline (1215-1236).
- **Command row:** Rail fill, 6px corners, 8px 10px padding. The command in Code, its purpose in Caption, and a compact copy button at the right (1254-1289). A command wraps only at spaces (`common.tsx:55-75`).
- **Notice:** Rail fill, 6px corners, an icon at the left. Warn turns Orange Wash with an orange triangle (725-742).
- **All clear:** Green Wash, Green Hairline, Shelf Green text at 500 (713-723).
- **Facts:** a two-column definition grid at 13px, Ink 2 terms at 500, 4px row gap (917-938).

### Inputs / Fields
- **Filter:** 34px tall, 300px wide up to 34vw, Paper, Hairline, 6px corners, a search icon, and an Ink 3 placeholder (389-420). Focus turns the border Shelf Green and adds a 2px Green Wash outline (403-406). Under 800px it fills the bar.
- **Select:** Paper, Hairline, 6px corners, 6px 8px padding (1364-1371). Only the shelf picker uses it.
- **Key cap:** 12px, Rail, Hairline with a 2px bottom, 4px corners (1742-1750).

### Navigation
- **Top bar:** 56px, sticky, Paper with a Hairline bottom. The mark at 26px wide, the name at 19px 700, a Hairline divider, then host, shelf, and project count in Ink 2 (299-362, `TopBar.tsx:50-87`). The view switch is a segmented control. Refresh is a default button with an icon that spins while busy (436-448).
- **Tree:** rows are 32px, 4px 8px padding, 6px corners. A project row holds a chevron, a folder, the path, and a count pill. Selected is Green Wash, Green Hairline, and Shelf Green at 600 (571-576). Items nest 22px in at 13px with a state icon (645-666). Arrow keys move focus (`ProjectTree.tsx:32-76`).
- **Drawer:** under 800px the tree slides in over 220ms above a scrim (1823-1845).

### Diff Table
The diff is the center of the surface.
- **Frame:** a diff file is a Hairline box with 6px corners. Its head is Rail with the path in Title (996-1011).
- **Table:** Code face, fixed layout. Column heads are 12px sans at 600 in Ink 2 with a Hairline between columns (1013-1043).
- **Rows:** number cells are right aligned in Ink 3 with a Soft Hairline at the left. Added lines use Add Wash with an Add Gutter number in Shelf Green. Removed lines use Delete Wash with a Delete Gutter number in Delete Ink. Empty cells are Rail. Hunk rows are Rail with Ink 3 text (1049-1117).
- **Modes:** side by side, three-way with installed, locked, and shelf columns, or unified under 800px (`DiffView.tsx:42-139`).
- **Syntax:** the quiet set from the Tertiary colors. Comments are italic in Ink 3.

## Do's and Don'ts

### Do:
- **Do** set every path, ref, digest, and command in the monospace stack, including page titles.
- **Do** give every icon a word: visible text beside it, or an accessible label on an icon-only button.
- **Do** use Orange Ink for attention text and Pin Orange for the icon beside it.
- **Do** show state as a border change: Hairline to Ink 3 for open, Green Hairline for selected.
- **Do** keep controls at 6px corners and containers at 8px.
- **Do** render an action as its exact command with a copy button.
- **Do** honor reduced motion. Every animation collapses to one frame and the changed panel stays Orange Wash (1895-1907).
- **Do** sort attention first in every list.

### Don't:
- **Don't** add a shadow, a blur, or a gradient to any surface.
- **Don't** use Pin Orange as a text color.
- **Don't** add a filled or colored primary button. The system has none.
- **Don't** fill an element with a color other than Green Wash or Orange Wash, except inside a diff table.
- **Don't** add a metric tile, a chart, or a stat card. The dashboard is panels and commands.
- **Don't** set chrome text above 22px or below 11px.
- **Don't** place uppercase tracked text above a title.
- **Don't** ship a webfont. The system faces are the type system.
