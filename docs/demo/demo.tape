# One shelf, two projects: a change in one project reaches the other only
# when that project asks for it. This is the README transcript, animated.
#
# Record it from the repository root:
#
#   ./docs/demo/setup.sh
#   vhs docs/demo/demo.tape
#
# setup.sh builds the sandbox under /tmp/capshelf-demo and compiles the
# binary the tape runs. env.sh points HOME at that sandbox.

Output docs/demo/demo.gif
Output docs/demo/demo.mp4

Set Shell bash
Set Theme "Catppuccin Mocha"
Set WindowBar Colorful
Set FontFamily "JetBrains Mono, DejaVu Sans Mono, Liberation Mono, monospace"
Set FontSize 16
Set LineHeight 1.2
Set Width 1520
Set Height 620
Set Padding 20
Set TypingSpeed 35ms
Set CursorBlink false

Hide
Type "source /tmp/capshelf-demo/env.sh && clear"
Enter
Show

# --- scene 1: other-app installs a skill from the shelf --------------------

Type "# One data repo holds the shared skills. other-app installs one."
Enter
Sleep 500ms
Type "cd ~/code/other-app"
Enter
Sleep 500ms
Type "capshelf ls"
Enter
Sleep 3.5s

Type "capshelf add"
Enter
Sleep 1.5s
Type "secrev"
Sleep 1.5s
Tab
Sleep 800ms
Enter
Sleep 3s

# --- scene 2: my-app edits its copy and promotes the edit ------------------

Hide
Type "clear"
Enter
Show

Type "# my-app edits its copy of the same skill."
Enter
Sleep 500ms
Type "cd ~/code/my-app"
Enter
Sleep 500ms
Type `echo '- f-strings inside a query' >> "$(capshelf get-path security-review)/SKILL.md"`
Enter
Sleep 1s
Type "capshelf status security-review --diff"
Enter
Sleep 4s

Type "# promote commits the edit to the data repo. It never pushes."
Enter
Sleep 500ms
Type `capshelf promote security-review -m "tighten SQLi check"`
Enter
Sleep 4s

# --- scene 3: other-app keeps its pin until it asks ------------------------

Hide
Type "clear"
Enter
Show

Type "# other-app still holds the version it pinned. Nothing there changed."
Enter
Sleep 500ms
Type "cd ~/code/other-app"
Enter
Sleep 500ms
Type "capshelf status"
Enter
Sleep 4s

Type "# Its files change only when someone runs update here."
Enter
Sleep 500ms
Type "capshelf update security-review"
Enter
Sleep 2.5s
Type "capshelf status"
Enter
Sleep 5s
