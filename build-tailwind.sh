#!/bin/sh
set -e
npx @tailwindcss/cli -i ./src/input.css -o ./assets/output.css --minify
