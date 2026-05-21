# Simple local server for index.html
# Save as server.py and run:
# python server.py

import http.server
import socketserver
import webbrowser
import os

PORT = 8000

# Change to the folder containing index.html
os.chdir(os.path.dirname(os.path.abspath(__file__)))

Handler = http.server.SimpleHTTPRequestHandler

with socketserver.TCPServer(("", PORT), Handler) as httpd:
    url = f"http://localhost:{PORT}/index.html"
    
    print(f"Serving at: {url}")
    
    # Open browser automatically
    webbrowser.open(url)

    httpd.serve_forever()