# Serves the dashboard on http://127.0.0.1:5500 with NO auto-reload.
# Run it from the folder that contains index.html (or pass the folder as an argument).
param([string]$Folder = ".")
python -m http.server 5500 --bind 127.0.0.1 --directory $Folder