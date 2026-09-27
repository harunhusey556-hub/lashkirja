# Viewport zoom

Pinch zoom is allowed. The viewport meta no longer sets `user-scalable=no` or `maximum-scale=1`.

iOS zooms the page when a focused field is under 16px. Inputs, selects, and textareas stay at 16px on phones (`globals.css`), so focusing a field does not move the shell. Double-tap zoom stays off through `touch-action: manipulation`, which still allows pinch.

The shell keeps filling the webview. Zoom changes the CSS pixel size of that view; header and tab padding still come from `env(safe-area-inset-*)` and the usable-area fallback. A WKWebView that cached an older page needs a refresh to pick up the new meta tag.
