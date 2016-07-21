import _ from 'lodash';
import SerialPort from 'serialport';
import log from '../../lib/log';
import GCodeSender from '../../lib/gcode-sender';
import TinyG2 from './TinyG2';
import {
    WORKFLOW_STATE_RUNNING,
    WORKFLOW_STATE_PAUSED,
    WORKFLOW_STATE_IDLE
} from '../../constants';

const PREFIX = '[TinyG2]';

const noop = () => {};

class Connection {
    socket = null;
    sentCommand = '';

    constructor(socket) {
        this.socket = socket;
    }
}

class TinyG2Controller {
    type = 'TinyG2';

    // Connections
    connections = [];

    // SerialPort
    options = {
        port: '',
        baudrate: 115200
    };
    serialport = null;

    // TinyG2
    tinyG2 = null;
    ready = false;
    state = {};

    // G-code sender
    sender = null;

    // Workflow state
    workflowState = WORKFLOW_STATE_IDLE;

    constructor(port, options) {
        const { baudrate } = { ...options };

        this.options = {
            ...this.options,
            port: port,
            baudrate: baudrate
        };

        // SerialPort
        this.serialport = new SerialPort(this.options.port, {
            autoOpen: false,
            baudrate: this.options.baudrate,
            parser: SerialPort.parsers.readline('\n')
        });

        // GCodeSender
        this.sender = new GCodeSender();
        this.sender.on('progress', (res) => {
            if (this.isClose()) {
                log.error(`${PREFIX} Serial port "${this.options.port}" not accessible`);
                return;
            }

            let { gcode = '' } = { ...res };
            gcode = ('' + gcode).trim();
            if (gcode.length > 0) {
                this.serialport.write(JSON.stringify({ gc: gcode }) + '\n');
            }
        });

        // TinyG2
        this.tinyG2 = new TinyG2(this.serialport);

        this.tinyG2.on('sr', (res) => {
            this.updateState();
        });

        this.tinyG2.on('fb', (res) => {
            this.updateState();
        });

        this.tinyG2.on('hp', (res) => {
            this.updateState();
        });

        this.tinyG2.on('raw', (res) => {
            this.connections.forEach((c) => {
                c.socket.emit('serialport:read', res.raw);
            });
        });
    }
    destroy() {
        if (this.tinyG2) {
            this.tinyG2.removeAllListeners();
            this.tinyG2 = null;
        }
    }
    updateState() {
        if (this.state === this.tinyG2.state) {
            return;
        }

        this.state = this.tinyG2.state;
        this.connections.forEach((c) => {
            c.socket.emit('TinyG2:state', this.state);
        });
    }
    init(callback = noop) {
        const cmds = [
            { pauseAfter: 500 },
            { cmd: '{"clear":null}', pauseAfter: 250 }, // Reset TinyG2
            { cmd: '?', pauseAfter: 150 },
            { cmd: '{"js":1}', pauseAfter: 150 },
            { cmd: '{"sr":null}' },
            { cmd: '{"sv":1}', pauseAfter: 50 },
            { cmd: '{"si":250}', pauseAfter: 50 },
            { cmd: '{"qr":null}' },
            { cmd: '{"qv":1}', pauseAfter: 50 },
            { cmd: '{"ec":0}', pauseAfter: 50 },
            { cmd: '{"jv":4}', pauseAfter: 50 },
            { cmd: '{"hp":null}' },
            { cmd: '{"fb":null}' },
            { cmd: '{"mt":n}' },
            {
                cmd: JSON.stringify({
                    sr: {
                        line: true,
                        posx: true,
                        posy: true,
                        posz: true,
                        vel: true,
                        unit: true,
                        stat: true,
                        feed: true,
                        coor: true,
                        momo: true,
                        plan: true,
                        path: true,
                        dist: true,
                        mpox: true,
                        mpoy: true,
                        mpoz: true
                    }
                }),
                pauseAfter: 250
            }
        ];

        const sendInitCommands = (i = 0) => {
            if (i >= cmds.length) {
                this.ready = true;
                callback();
                return;
            }
            const { cmd = '', pauseAfter = 0 } = { ...cmds[i] };
            if (cmd) {
                this.connections.forEach((c) => {
                    c.socket.emit('serialport:write', cmd);
                });
                this.serialport.write(cmd + '\n');
                log.raw('debug', 'TinyG2> ' + cmd);
            }
            setTimeout(() => {
                sendInitCommands(i + 1);
            }, pauseAfter);
        };
        sendInitCommands();
    }
    get status() {
        return {
            port: this.options.port,
            baudrate: this.options.baudrate,
            connections: _.size(this.connections),
            ready: this.ready,
            controller: {
                type: this.type,
                state: this.state
            },
            workflowState: this.workflowState,
            gcode: {
                name: this.sender.name,
                size: this.sender.gcode.length,
                remain: this.sender.remain.length,
                sent: this.sender.sent.length,
                total: this.sender.total,
                createdTime: this.sender.createdTime,
                startedTime: this.sender.startedTime,
                finishedTime: this.sender.finishedTime
            }
        };
    }
    reset() {
        this.ready = false;
        this.workflowState = WORKFLOW_STATE_IDLE;
    }
    open(callback = noop) {
        const { port } = this.options;

        // Assertion check
        if (this.isOpen()) {
            callback(new Error('Cannot open serial port ' + port));
            return;
        }

        this.serialport.open((err) => {
            if (err) {
                callback(err);
                return;
            }

            this.serialport.on('data', (data) => {
                this.tinyG2.parse('' + data);
                log.raw('silly', _.trimEnd('TinyG2> ' + data));
            });

            this.serialport.on('disconnect', (err) => {
                log.warn(`${PREFIX} Disconnected from serial port "${port}": err=${JSON.stringify(err)}`);
                this.destroy();
            });

            this.serialport.on('error', (err) => {
                log.error(`${PREFIX} Unexpected error while reading/writing serial port "${port}": err=${JSON.stringify(err)}`);
                this.destroy();
            });

            log.debug(`${PREFIX} Connected to serial port "${port}"`);

            // Reset
            this.reset();

            // Unload G-code
            this.command(null, 'unload');

            // Initialize the controller
            this.init(callback);
        });
    }
    close(callback = noop) {
        const { port } = this.options;

        // Assertion check
        if (this.isClose()) {
            callback(new Error('Cannot close serial port ' + port));
            return;
        }

        // Reset TinyG2 while closing serial port
        this.command(null, 'reset');

        this.serialport.close((err) => {
            this.destroy();
            callback(err);
        });
    }
    isOpen() {
        return this.serialport.isOpen();
    }
    isClose() {
        return !(this.isOpen());
    }
    addConnection(socket) {
        this.connections.push(new Connection(socket));

        if (!_.isEmpty(this.state)) {
            // Send current state to the connected client
            socket.emit('TinyG2:state', this.state);
        }
    }
    removeConnection(socket) {
        const index = _.findIndex(this.connections, (c) => {
            return c.socket === socket;
        });
        this.connections.splice(index, 1);
    }
    command(socket, cmd, ...args) {
        const handler = {
            'load': () => {
                const [name, gcode, callback] = args;

                this.sender.load(name, gcode, (err) => {
                    if (err) {
                        callback(err);
                        return;
                    }

                    log.debug(`${PREFIX} Load G-code: name="${this.sender.name}", size=${this.sender.gcode.length}, total=${this.sender.total}`);

                    this.workflowState = WORKFLOW_STATE_IDLE;
                    callback();
                });
            },
            'unload': () => {
                log.debug(`${PREFIX} Unload G-code: name="${this.sender.name}"`);

                this.workflowState = WORKFLOW_STATE_IDLE;
                this.sender.unload();
            },
            'start': () => {
                this.workflowState = WORKFLOW_STATE_RUNNING;
                this.sender.next();
            },
            'stop': () => {
                this.workflowState = WORKFLOW_STATE_IDLE;
                this.sender.rewind();
            },
            'pause': () => {
                this.workflowState = WORKFLOW_STATE_PAUSED;
                this.writeln(socket, '!');
                this.writeln(socket, '{"qr":""}');
            },
            'resume': () => {
                this.writeln(socket, '~');
                this.writeln(socket, '{"qr":""}');
                this.workflowState = WORKFLOW_STATE_RUNNING;
                this.sender.next();
            },
            'feedhold': () => {
                this.writeln(socket, '!');
                this.writeln(socket, '{"qr":""}');
            },
            'cyclestart': () => {
                this.writeln(socket, '~');
                this.writeln(socket, '{"qr":""}');
            },
            'queueflush': () => {
                this.writeln(socket, '%');
                this.writeln(socket, '{"qr":""}');
            },
            'reset': () => {
                this.writeln(socket, '{"clear":null}');
            },
            'homing': () => {
                this.writeln(socket, 'G28.2 X0 Y0 Z0 A0');
            },
            'gcode': () => {
                const gcode = args.join(' ');
                this.writeln(socket, JSON.stringify({ gc: gcode }));
            }
        }[cmd];

        if (!handler) {
            log.error(`${PREFIX} Unknown command: ${cmd}`);
            return;
        }

        handler();
    }
    write(socket, data) {
        socket && socket.emit('serialport:write', data);
        const index = _.findIndex(this.connections, (c) => {
            return c.socket === socket;
        });
        if (index >= 0) {
            this.connections[index].sentCommand = data;
        }
        this.serialport.write(data);
        log.raw('silly', _.trimEnd('TinyG2> ' + data));
    }
    writeln(socket, data) {
        this.write(socket, data + '\n');
    }
}

export default TinyG2Controller;
