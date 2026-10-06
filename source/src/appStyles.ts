// The signed-in app's stylesheet, and the booking widget's.
//
// Imported by each shell that draws with it (the coach workspace, the player
// portal, the public booking widget, the login screen, the share pages) rather
// than by the page entry, so the public site and the first paint of every page
// stop downloading 290 KB of CSS they never use. Vite gives the shells one
// shared chunk for it, loaded once, before each shell's own stylesheets.
//
// tokens.css and base.css are the entry's: every stylesheet reads --c-*.
import "./styles.css";
// After styles.css: the app-wide switch settles the ties with the per-screen
// rules that used to size these as tick boxes.
import "./switches.css";
