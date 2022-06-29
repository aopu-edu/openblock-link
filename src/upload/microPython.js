const fs = require('fs');
const {spawn} = require('child_process');
const path = require('path');
const ansi = require('ansi-string');
const os = require('os');

const OBMPY_MODULE_NAME = 'obmpy';
const ESPTOOL_MODULE_NAME = 'esptool';
const KFLASH_MODULE_NAME = 'kflash';

class MicroPython {
    constructor (peripheralPath, config, userDataPath, toolsPath, sendstd) {
        this._peripheralPath = peripheralPath;
        this._config = config;
        this._userDataPath = userDataPath;
        this._projectPath = path.join(userDataPath, 'microPython/project');
        this._pythonPath = path.join(toolsPath, 'Python');
        this._firmwareDir = path.join(toolsPath, '../firmwares/microPython');
        this._sendstd = sendstd;

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
        this._existedLibFile = []; // Existing files in the board
        this._bfree = -1; // block free of board
        this._bsize = 0; // block size of board
    }

    async flash (code, library = []) {
        const fileToPut = [];

        if (!fs.existsSync(this._projectPath)) {
            fs.mkdirSync(this._projectPath, {recursive: true});
        }

        try {
            fs.writeFileSync(this._codefilePath, code);
        } catch (err) {
            return Promise.reject(err);
        }

        fileToPut.push(this._codefilePath);

        library.forEach(lib => {
            if (fs.existsSync(lib)) {
                const libraries = fs.readdirSync(lib);
                libraries.forEach(file => {
                    fileToPut.push(path.join(lib, file));
                });
            }
        });

        // If we can not entry raw REPL, we should flash micro python firmware first.
        try {
            await this.checkLibFileList();
            await this.checkRestSpace();

            const reflashFirmware = this.judgeReflashFirmware(fileToPut, this._config.chip);
            if (reflashFirmware) {
                // If the subspace of the board is insufficient, uploaded the firmware again
                this._sendstd(`${ansi.yellow_dark}The space of board is insufficient.\n`);
                this._sendstd(`${ansi.clear}Try to flash micropython firmware to ` +
                    `refresh the memory space of the board.\n`);
                
                try {
                    this._existedLibFile = [];
                    await this.flashFirmware();
                } catch (e) {
                    return Promise.reject(e);
                }
            }
        } catch (err) {
            this._sendstd(`${ansi.yellow_dark}Could not enter raw REPL.\n`);
            this._sendstd(`${ansi.clear}Try to flash micro python firmware to fix.\n`);

            try {
                await this.flashFirmware();
            } catch (e) {
                return Promise.reject(e);
            }
        }

        this._sendstd('Writing files...\n');

        for (const file of fileToPut) {
            const fileName = file.substring(file.lastIndexOf('\\') + 1);
            const pushed = this._existedLibFile.find(item => fileName === item);
            if (!pushed || fileName === 'main.py') {
                try {
                    await this.obmpyPut(file);
                } catch (err) {
                    return Promise.reject(err);
                }
            } else {
                this._sendstd(`${file} already writed\n`);
            }
            
        }

        this._sendstd(`${ansi.green_dark}Success\n`);
        return Promise.resolve();
    }

    // Check whether the subspace on the board is sufficient
    // to determine whether to upload the firmware again
    judgeReflashFirmware (fileToPut, boardType) {
        let totalSize = 0;
        fileToPut.forEach(file => {
            const fileName = file.substring(file.lastIndexOf('\\') + 1);
            const exsisted = this._existedLibFile.find(item => fileName === item);
            if (!exsisted || fileName === 'main.py') {
                const fileSize = fs.statSync(file).size;
                if (boardType === 'k210') {
                    // In k210, the files are densely packed
                    totalSize += fileSize;
                } else {
                    // In esp32 && esp8266, the files are stored by block
                    totalSize += Math.ceil(fileSize / this._bsize);
                }
            }
        });
        let reflashFirmware = 0;
        if (boardType === 'k210') {
            // When space of k210 is less than 100 bytes, reflash firmware
            reflashFirmware = ((this._bfree * this._bsize) - totalSize < 100) ? 1 : 0;
        } else {
            // When space of esp32 or esp8266 is less than 2 blocks, reflash firmware
            reflashFirmware = (this._bfree - totalSize) < 2 ? 1 : 0;
        }
        
        return reflashFirmware;
    }

    checkRestSpace () {
        this._sendstd(`Try to check rest space.\n`);

        return new Promise((resolve, reject) => {
            const arg = [
                `-m${OBMPY_MODULE_NAME}`,
                `-p${this._peripheralPath}`,
                '-d1', // delay 1s to wait for device ready
                `-r${this._config.rtsdtr === false ? 'F' : 'T'}`,
                'restspace'
            ];

            if (this._config.chip === 'k210') {
                arg.splice(4, 0, '-a1'); // if k210 just send abort command once
                // add argument of command restspace, the file directory of k210 is /flash
                arg.splice(6, 0, '/flash');
            }

            const obmpy = spawn(this._pyPath, arg);
            
            obmpy.stdout.on('data', buf => {
                // It seems that avrdude didn't use stdout.
                const data = JSON.parse(buf.toString().trim()
                    .replace(new RegExp('\'', 'g'), '"'));
                this._bsize = data.bsize;
                this._bfree = data.bfree;
            });
            obmpy.on('exit', outCode => {
                switch (outCode) {
                case 0:
                    return resolve();
                default:
                    return reject();
                }
            });
        });
    }

    checkLibFileList () {
        this._sendstd(`Try to enter raw REPL.\n`);

        return new Promise((resolve, reject) => {
            const arg = [
                `-m${OBMPY_MODULE_NAME}`,
                `-p${this._peripheralPath}`,
                '-d1', // delay 1s to wait for device ready
                `-r${this._config.rtsdtr === false ? 'F' : 'T'}`,
                'ls'
            ];

            if (this._config.chip === 'k210') {
                arg.splice(4, 0, '-a1'); // if k210 just send abort command once
            }

            const obmpy = spawn(this._pyPath, arg);

            obmpy.stdout.on('data', buf => {
                // It seems that avrdude didn't use stdout.
                let data = buf.toString().trim();
                data = data.replace(new RegExp('[/\\r]', 'g'), '');
                this._existedLibFile = data.split('\n');
            });

            obmpy.on('exit', outCode => {
                switch (outCode) {
                case 0:
                    return resolve();
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

            obmpy.on('exit', outCode => {
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

            esptools.on('exit', outCode => {
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

            kflash.on('exit', outCode => {
                switch (outCode) {
                case 0:
                    return resolve();
                default:
                    return reject('kflash failed flash');
                }
            });
        });
    }
}

module.exports = MicroPython;
