# Records docs/demo.gif. Run from this directory: vhs demo.tape
# Needs vhs (brew install vhs) and a working pith. It makes real model calls.
Output demo.gif
Set Shell zsh
Set FontSize 18
Set Width 1100
Set Height 620
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 45ms
Set PlaybackSpeed 1.5

# A scratch repo with one bug: add() subtracts.
Hide
Type "mkdir -p /tmp/pith-demo && cd /tmp/pith-demo"
Enter
Type "echo 'export const add = (a, b) => a - b;' > add.mjs"
Enter
Type `printf "import { add } from './add.mjs';\n\nif (add(2, 3) !== 5) {\n  console.error('FAIL: add(2, 3) should be 5');\n  process.exit(1);\n}\nconsole.log('PASS');\n" > test.mjs`
Enter
Type "clear"
Enter
Show

Type "pith"
Sleep 400ms
Enter
Sleep 1200ms
Type "the test is failing. find the bug and fix it."
Sleep 500ms
Enter
Wait+Screen@90s /~\$/
Sleep 2500ms
Type "search the web: what is the current Node.js LTS? one line."
Sleep 500ms
Enter
Wait+Screen@90s /web lookup/
Sleep 4s
