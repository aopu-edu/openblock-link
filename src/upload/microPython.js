const fs = require('fs');
const {spawn} = require('child_process');
const path = require('path');
const ansi = require('ansi-string');
const os = require('os');

const OBMPY_MODULE_NAME = 'obmpy';
const ESPTOOL_MODULE_NAME = 'esptool';
const KFLASH_MODULE_NAME = 'kflash';

const K210_RESERVED_SPACE = 100; // 100 bytes
const ESP_RESERVED_BLOCKS = 1; // 1 blocks
const CHECK_ABORT_STATE_TIME = 200;

class MicroPython {
    constructor (peripheralPath, config, userDataPath, toolsPath, sendstd) {
        this._peripheralPath = peripheralPath;
        this._config = config;
        this._userDataPath = userDataPath;
        this._projectPath = path.join(userDataPath, 'microPython/project');
        this._pythonPath = path.join(toolsPath, 'Python');
        this._firmwareDir = path.join(toolsPath, '../firmwares/microPython');
        this._sendstd = sendstd;

        this._beAbort = false;

        if (os.platform() === 'darwin') {
            this._pyPath = path.join(this._pythonPath, 'python3');
        } else {
            this._pyPath = path.join(this._pythonPath, 'python');
        }

        // If the baud is an object means the value of this parameter is
        // different under different systems.
        if (typeof this._config.baud === 'object') {
            this._config.baud = this._config.baud[os.platform()];
        }

        this._codefilePath = path.join(this._projectPath, 'main.py');
    }

    async flash (code, library = []) {
        const filesToPut = [];
        let existedFiles = [];

        if (!fs.existsSync(this._projectPath)) {
            fs.mkdirSync(this._projectPath, {recursive: true});
        }

        try {
            fs.writeFileSync(this._codefilePath, code);
        } catch (err) {
            return Promise.reject(err);
        }

        filesToPut.push(this._codefilePath);

        library.forEach(lib => {
            if (this._beAbort === true) {
                return Promise.reject('Aborted');
            }
            if (fs.existsSync(lib)) {
                const libraries = fs.readdirSync(lib);
                libraries.forEach(file => {
                    filesToPut.push(path.join(lib, file));
                });
            }
        });

        // If we can not entry raw REPL, we should flash micro python firmware first.
        try {
            let rootPath = '/';
            existedFiles = await this.checkFileList();

            // If the root path return a directory named flash or sd means that
            // this device supports multiple storage media. If no sdcard we shuold
            // use /flash as root path, otherwise we should use /sd as root path.
            if (existedFiles.includes('flash')) {
                rootPath = '/flash';

                // The priority of sd card is higher than flash.
                if (existedFiles.includes('sd')) {
                    rootPath = '/sd';
                }
                // Reread the file list in the root path
                existedFiles = await this.checkFileList(rootPath);
            }
            const fsInfo = await this.checkFreeSpace(rootPath);

            if (this.shouldClearFiles(filesToPut, existedFiles, fsInfo)) {
                if (this._beAbort === true) {
                    return Promise.reject('Aborted');
                }
                if (rootPath === '/flash' || rootPath === '/') {
                    this._sendstd(`${ansi.yellow_dark}The free space of the board is not enough.\n`);
                    this._sendstd(`${ansi.clear}Try to reflash micropython firmware to ` +
                    `clear the file system of the board.\n`);
                    try {
                        await this.flashFirmware();
                    } catch (e) {
                        return Promise.reject(e);
                    }
                } else {
                    return Promise.reject('${ansi.red}The free space of the sd card is not enough. ' +
                        'You need to clear it manually\n');
                }
            }
        } catch (err) {
            if (err) {
                console.error('Flash error:', err);
                if (err === 'Aborted') {
                    return Promise.reject(err);
                }
            }
            this._sendstd(`${ansi.yellow_dark}Could not enter raw REPL.\n`);
            this._sendstd(`${ansi.clear}Try to flash micro python firmware to fix.\n`);

            try {
                await this.flashFirmware();
            } catch (e) {
                return Promise.reject(e);
            }
        }

        this._sendstd('Writing files...\n');

        for (const file of filesToPut) {
            const fileName = path.basename(file);
            const pushed = existedFiles.find(item => fileName === item);
            if (!pushed || fileName === 'main.py') {
                try {
                    await this.obmpyPut(file);
                } catch (err) {
                    return Promise.reject(err);
                }
            } else {
                this._sendstd(`${file} already exists, skip\n`);
            }

        }

        this._sendstd(`${ansi.green_dark}Success\n`);
        return Promise.resolve();
    }

    shouldClearFiles (fileToPut, existedFiles, fsInfo) {
        let totalSize = 0;
        let totalBlock = 0;

        fileToPut.forEach(file => {
            const fileName = path.basename(file);
            const exsisted = existedFiles.find(item => fileName === item);
            if (!exsisted || fileName === 'main.py') {
                const fileSize = fs.statSync(file).size;
                if (this._config.chip === 'k210') {
                    // For k210, the files are densely stored
                    totalSize += fileSize;
                } else {
                    // For esp32/8266, the files are stored by block
                    totalBlock += Math.ceil(fileSize / fsInfo.bsize);
                }
            }
        });

        if (this._config.chip === 'k210') {
            // When the free space of k210 is less than x bytes, clear all files
            return ((this._bfree * this._bsize) - totalSize) < K210_RESERVED_SPACE;
        }
        // When the free space of esp32/8266 is less than x blocks, clear all files
        return (this._bfree - totalBlock) < ESP_RESERVED_BLOCKS;
    }

    checkFreeSpace (_path = '/') {
        this._sendstd(`Check the size of available free space on path "${_path}".\n`);

        return new Promise((resolve, reject) => {
            const arg = [
                `-m${OBMPY_MODULE_NAME}`,
                `-p${this._peripheralPath}`,
                '-d1', // delay 1s to wait for device ready
                `-r${this._config.rtsdtr === false ? 'F' : 'T'}`,
                'fsi',
                `${_path}`
            ];

            if (this._config.chip === 'k210') {
                arg.splice(4, 0, '-a1'); // if k210 just send abort command once
            }

            const obmpy = spawn(this._pyPath, arg);

            let bsize = 0; // one block size of the board
            let bfree = 0; // block free of the board

            obmpy.stdout.on('data', buf => {
                // It seems that avrdude didn't use stdout.
                const data = JSON.parse(buf.toString().trim()
                    .replace(new RegExp('\'', 'g'), '"'));
                bsize = data.bsize;
                bfree = data.bfree;
            });

            const listenAbortSignal = setInterval(() => {
                if (this._beAbort) {
                    obmpy.kill();
                    return reject('Aborted');
                }
            }, CHECK_ABORT_STATE_TIME);

            obmpy.on('exit', outCode => {
                clearInterval(listenAbortSignal);
                switch (outCode) {
                case 0:
                    return resolve({bsize, bfree});
                default:
                    return reject();
                }
            });
        });
    }

    checkFileList (_path = '/') {
        this._sendstd(`Read the exited files on path "${_path}".\n`);

        return new Promise((resolve, reject) => {
            const arg = [
                `-m${OBMPY_MODULE_NAME}`,
                `-p${this._peripheralPath}`,
                '-d1', // delay 1s to wait for device ready
                `-r${this._config.rtsdtr === false ? 'F' : 'T'}`,
                'ls',
                `${_path}`
            ];

            if (this._config.chip === 'k210') {
                arg.splice(4, 0, '-a1'); // if k210 just send abort command once
            }

            const obmpy = spawn(this._pyPath, arg);

            const existedFiles = [];
            obmpy.stdout.on('data', buf => {
                let data = buf.toString().trim();
                data = data.replace(new RegExp('[\\r]', 'g'), '');
                const files = data.split('\n');
                for (let file of files) {
                    file = file.substring(file.lastIndexOf('/') + 1);
                    existedFiles.push(file);
                }
            });

            const listenAbortSignal = setInterval(() => {
                if (this._beAbort) {
                    obmpy.kill();
                    return reject('Aborted');
                }
            }, CHECK_ABORT_STATE_TIME);

            obmpy.on('exit', outCode => {
                clearInterval(listenAbortSignal);
                switch (outCode) {
                case 0:
                    return resolve(existedFiles);
                default:
                    return reject();
                }
            });
        });
    }

    obmpyPut (file) {
        return new Promise((resolve, reject) => {
            const arg = [
                `-m${OBMPY_MODULE_NAME}`,
                '-d1',
                `-p${this._peripheralPath}`,
                `-r${this._config.rtsdtr === false ? 'F' : 'T'}`,
                'put',
                file
            ];

            if (this._config.chip === 'k210') {
                arg.splice(4, 0, '-a1');
            }

            const obmpy = spawn(this._pyPath, arg);

            const listenAbortSignal = setInterval(() => {
                if (this._beAbort) {
                    obmpy.kill();
                    return reject('Aborted');
                }
            }, CHECK_ABORT_STATE_TIME);


            obmpy.on('exit', outCode => {
                clearInterval(listenAbortSignal);
                switch (outCode) {
                case 0:
                    this._sendstd(`${file} write finish\n`);
                    return resolve();
                default:
                    return reject('obmpy failed to write');
                }
            });
        });
    }

    async flashFirmware () {
        if (this._config.chip === 'esp32' || this._config.chip === 'esp8266') {
            return await this.espflashFirmware();
        } else if (this._config.chip === 'k210') {
            return await this.k210flashFirmware();
        }
        return Promise.reject('unknown chip type');
    }

    async espflashFirmware () {
        const erase = () => new Promise((resolve, reject) => {
            const esptools = spawn(this._pyPath,
                [
                    `-m${ESPTOOL_MODULE_NAME}`,
                    '--chip', this._config.chip,
                    '--port', this._peripheralPath,
                    'erase_flash'
                ]);

            esptools.stdout.on('data', buf => {
                this._sendstd(buf.toString());
            });

            const listenAbortSignal = setInterval(() => {
                if (this._beAbort) {
                    esptools.kill();
                    return reject('Aborted');
                }
            }, CHECK_ABORT_STATE_TIME);

            esptools.on('exit', outCode => {
                clearInterval(listenAbortSignal);
                switch (outCode) {
                case 0:
                    return resolve();
                default:
                    return reject('esptool failed to erase');
                }
            });
        });

        const flash = () => new Promise((resolve, reject) => {
            const args = [
                `-m${ESPTOOL_MODULE_NAME}`,
                '--chip', this._config.chip,
                '--port', this._peripheralPath,
                '--baud', this._config.baud
            ];

            if (this._config.chip === 'esp32') {
                args.push('write_flash');
                args.push('-z', '0x1000');
            } else if (this._config.chip === 'esp8266') {
                args.push('write_flash');
                args.push('--flash_size=detect', '0');
            } else {
                return reject('unknown chip type');
            }

            args.push(path.join(this._firmwareDir, this._config.firmware));

            const esptools = spawn(this._pyPath, args);

            esptools.stdout.on('data', buf => {
                this._sendstd(buf.toString());
            });

            esptools.on('exit', outCode => {
                switch (outCode) {
                case 0:
                    return resolve();
                default:
                    return reject('esptool failed flash');
                }
            });
        });

        try {
            await erase();
            await flash();

            return Promise.resolve();
        } catch (err) {
            return Promise.reject(err);
        }
    }

    k210flashFirmware () {
        return new Promise((resolve, reject) => {
            const args = [
                `-m${KFLASH_MODULE_NAME}`,
                `-p${this._peripheralPath}`,
                `-b${this._config.baud}`,
                `-B${this._config.board}`
            ];

            if (this._config.slowMode) {
                args.push('-S');
            }

            args.push(path.join(this._firmwareDir, this._config.firmware));

            const kflash = spawn(this._pyPath, args);

            kflash.stdout.on('data', buf => {
                this._sendstd(buf.toString());
            });

            const listenAbortSignal = setInterval(() => {
                if (this._beAbort) {
                    kflash.kill();
                    return reject('Aborted');
                }
            }, CHECK_ABORT_STATE_TIME);

            kflash.on('exit', outCode => {
                clearInterval(listenAbortSignal);
                switch (outCode) {
                case 0:
                    return resolve();
                default:
                    return reject('kflash failed flash');
                }
            });
        });
    }

    abortUpload () {
        this._beAbort = true;
    }
}

module.exports = MicroPython;
