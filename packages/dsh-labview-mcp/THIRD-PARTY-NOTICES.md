# Third-Party Notices

This is the `dsh-labview-mcp` DSH plugin package. It contains the bundle
manifest, Host plugin, and display resources only. It declares the optional
platform package `dsh-labview-mcp-win32-x64`, which ships the full upstream
runtime tree under its `runtime/` directory. The components below are
third-party software redistributed by that binary package; this plugin package
is MIT-licensed (see `LICENSE`).

## 1. Zuehlke labview-mcp

- Project: labview-mcp
- Source: https://github.com/Zuehlke/labview-mcp
- License: MIT
- Copyright (c) 2026 Zühlke

The binary package redistributes the complete upstream release tree unmodified
under `runtime/`. A copy of its MIT license is shipped at the plugin package
root as `LICENSE-Zuehlke.txt` (and by the binary package as `LICENSE`). Its MIT
license follows:

```
MIT License

Copyright (c) 2026 Zühlke

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 2. pylabview

- Project: pylabview
- License: MIT
- Copyright (C) 2013 Jessica Creighton <jcreigh@femtobit.org>
- Copyright (C) 2019-2020 Mefistotelis <mefistotelis@gmail.com>

pylabview is bundled by the binary package under `runtime/bin/pylabview/`. A
copy of its license is shipped at the plugin package root as
`LICENSE-pylabview.txt` (and inside the runtime as
`runtime/bin/pylabview/app/LICENSE-pylabview.txt`). Its MIT license follows:

```
MIT License

Copyright (C) 2013 Jessica Creighton <jcreigh@femtobit.org>
Copyright (C) 2019-2020 Mefistotelis <mefistotelis@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 3. Python 3.12

- Project: Python
- Source: https://www.python.org/
- License: Python Software Foundation License (PSF)
- Copyright (c) Python Software Foundation

A Python 3.12 interpreter is bundled by the binary package under
`runtime/bin/pylabview/` solely to run pylabview. It is distributed under the
PSF License Agreement. The full license text and the licenses of software
incorporated into Python are available at
https://docs.python.org/3/license.html and in the Python source distribution's
`LICENSE` file.
