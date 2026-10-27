import { build } from 'esbuild';
import fs from 'node:fs';
await build({entryPoints:['node_modules/pdfjs-dist/build/pdf.mjs'],bundle:true,format:'iife',globalName:'pdfjsLib',outfile:'vendor/pdf.min.js',minify:true,target:'es2022',logLevel:'warning'});
await build({entryPoints:['node_modules/pdfjs-dist/build/pdf.worker.mjs'],bundle:true,format:'iife',globalName:'pdfjsWorker',outfile:'vendor/pdf.worker.min.js',minify:true,target:'es2022',logLevel:'warning'});
fs.copyFileSync('node_modules/pdfjs-dist/LICENSE','vendor/PDFJS-LICENSE.txt');
