import { 
  getVoiceConnection, 
  joinVoiceChannel, 
  VoiceConnection,
  VoiceConnectionStatus,
  entersState,
  AudioReceiveStream
} from '@discordjs/voice';
import { CommandInteraction, GuildMember } from 'discord.js';
import { logger } from '../../config/index.js';
import { Embeds } from '../../utils/index.js';
import { ElevenLabsConversationalAI } from '../elevenlabs/conversationalClient.js';

/**
 * Manages voice connections for a Discord bot, handling connection and disconnection from voice channels.
 * Includes sophisticated voice activity detection and audio processing.
 *
 * @class VoiceConnectionHandler
 * @property {CommandInteraction} interaction - The Discord command interaction instance
 * @property {VoiceConnection | null} connection - The current voice connection, if any
 */
class VoiceConnectionHandler {
  private interaction: CommandInteraction;
  private isSpeaking: boolean = false;
  private silenceTimer: NodeJS.Timeout | null = null;
  private audioLevel: number = 0;
  private readonly SILENCE_THRESHOLD = 500; // ms to wait before considering speech ended
  private readonly NOISE_THRESHOLD = -50; // dB threshold for noise
  private readonly SPEECH_THRESHOLD = -35; // dB threshold for speech
  private consecutiveNoiseFrames: number = 0;
  private readonly REQUIRED_NOISE_FRAMES = 3; // Number of consecutive frames needed to confirm speech
  private currentConnection: VoiceConnection | null = null;

  /**
   * Creates an instance of VoiceConnectionHandler.
   * @param {CommandInteraction} interaction - The command interaction from Discord.
   */
  constructor(interaction: CommandInteraction) {
    this.interaction = interaction;
  }

  /**
   * Attempts to connect the bot to the voice channel of the user who invoked the command.
   * Sets up voice activity detection and audio processing.
   *
   * @async
   * @returns {Promise<VoiceConnection | void>} The voice connection if successful, void if connection fails
   * @throws Will throw an error if connection fails unexpectedly
   */
  async connect(): Promise<VoiceConnection | void> {
    try {
      if (!this.isUserInVoiceChannel()) {
        return;
      }

      const existingConnection = getVoiceConnection(this.interaction.guildId!);
      if (existingConnection) {
        await this.interaction.reply({
          embeds: [Embeds.error('Error', 'Bot is already in a voice channel.')],
          ephemeral: true,
        });
        return;
      }

      const member = this.interaction.member as GuildMember;
      const connection = joinVoiceChannel({
        channelId: member.voice.channel!.id,
        guildId: this.interaction.guildId!,
        adapterCreator: member.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false,
      });

      try {
        // Wait for the connection to be ready
        await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
        this.currentConnection = connection;
        this.setupConnectionHandlers(connection);

        await this.interaction.reply({
          embeds: [Embeds.success('Connected', "Let's chat!")],
        });
        return connection;
      } catch (error) {
        connection.destroy();
        throw error;
      }

    } catch (error) {
      logger.error(error, 'Error connecting to voice channel');
      await this.interaction.reply({
        embeds: [Embeds.error('Error', 'An error occurred while connecting to the voice channel.')],
        ephemeral: true,
      });
    }
  }

  /**
   * Sets up handlers for voice connection events and audio processing.
   * @private
   * @param {VoiceConnection} connection - The voice connection to set up handlers for
   */
  private setupConnectionHandlers(connection: VoiceConnection) {
    connection.receiver.speaking.on('start', (userId) => {
      this.handleAudioStart(userId);
    });

    connection.receiver.speaking.on('end', (userId) => {
      this.handleAudioEnd(userId);
    });

    // Handle connection state changes
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch (error) {
        connection.destroy();
        this.currentConnection = null;
      }
    });

    connection.on(VoiceConnectionStatus.Destroyed, () => {
      this.currentConnection = null;
    });

    // Subscribe to audio streams
    connection.receiver.speaking.on('start', (userId) => {
      const audioStream = connection.receiver.subscribe(userId);
      this.handleAudioStream(audioStream);
    });
  }

  /**
   * Processes audio stream data to detect genuine speech.
   * @private
   * @param {AudioReceiveStream} audioStream - The audio stream to process
   */
  private handleAudioStream(audioStream: AudioReceiveStream) {
    audioStream.on('data', (chunk: Buffer) => {
      const audioLevel = this.calculateAudioLevel(chunk);
      this.processAudioLevel(audioLevel);
    });

    audioStream.on('end', () => {
      logger.debug('Audio stream ended');
    });
  }

  /**
   * Processes audio levels to determine if genuine speech is occurring.
   * @private
   * @param {number} audioLevel - The calculated audio level in dB
   */
  private processAudioLevel(audioLevel: number) {
    if (audioLevel > this.NOISE_THRESHOLD) {
      this.consecutiveNoiseFrames++;
      
      if (audioLevel > this.SPEECH_THRESHOLD && 
          this.consecutiveNoiseFrames >= this.REQUIRED_NOISE_FRAMES) {
        if (!this.isSpeaking) {
          this.handleSpeechStart();
        }
        if (this.silenceTimer) {
          clearTimeout(this.silenceTimer);
          this.silenceTimer = null;
        }
      }
    } else {
      this.consecutiveNoiseFrames = 0;
      if (this.isSpeaking && !this.silenceTimer) {
        this.silenceTimer = setTimeout(() => {
          this.handleSpeechEnd();
        }, this.SILENCE_THRESHOLD);
      }
    }
  }

  /**
   * Calculates the audio level from raw audio data.
   * @private
   * @param {Buffer} chunk - The audio data chunk
   * @returns {number} The calculated audio level in dB
   */
  private calculateAudioLevel(chunk: Buffer): number {
    const samples = new Int16Array(chunk.buffer);
    let sum = 0;
    
    for (let i = 0; i < samples.length; i++) {
      sum += samples[i] * samples[i];
    }
    
    const rms = Math.sqrt(sum / samples.length);
    return 20 * Math.log10(rms / 32768); // Convert to dB
  }

  /**
   * Handles the start of detected speech.
   * @private
   */
  private handleSpeechStart() {
    this.isSpeaking = true;
    logger.info('Real speech detected');
    this.emit('realSpeechStart');
  }

  /**
   * Handles the end of detected speech.
   * @private
   */
  private handleSpeechEnd() {
    this.isSpeaking = false;
    this.consecutiveNoiseFrames = 0;
    this.silenceTimer = null;
    logger.info('Speech ended');
    this.emit('realSpeechEnd');
  }

  /**
   * Handles initial audio detection.
   * @private
   * @param {string} userId - The ID of the user who started speaking
   */
  private handleAudioStart(userId: string) {
    logger.debug(`Audio started from user: ${userId}`);
  }

  /**
   * Handles audio stream end.
   * @private
   * @param {string} userId - The ID of the user who stopped speaking
   */
  private handleAudioEnd(userId: string) {
    logger.debug(`Audio ended from user: ${userId}`);
  }

  /**
   * Validates that the user who invoked the command is in a voice channel.
   * @private
   * @returns {boolean} True if the member is in a voice channel, false otherwise
   */
  private isUserInVoiceChannel(): boolean {
    if (!(this.interaction.member instanceof GuildMember && this.interaction.member.voice.channel)) {
      this.interaction.reply({
        embeds: [Embeds.error('Error', 'You need to be in a voice channel to use this command.')],
        ephemeral: true,
      });
      return false;
    }
    return true;
  }

  /**
   * Disconnects the bot from the current voice channel.
   * @async
   * @returns {Promise<boolean>} True if successfully disconnected, false otherwise
   */
  async disconnect(): Promise<boolean> {
    try {
      const connection = getVoiceConnection(this.interaction.guildId!);
      if (!connection) {
        return false;
      }

      connection.destroy();
      this.currentConnection = null;
      return true;
    } catch (error) {
      logger.error(error, 'Error disconnecting from voice channel');
      return false;
    }
  }

  /**
   * Emits events for the ConversationalClient to handle.
   * @private
   * @param {string} event - The name of the event to emit
   */
  private emit(event: string) {
    logger.info(`Emitting event: ${event}`);
    // Implement your event emission logic here
  }

  /**
   * Checks if the bot is currently detecting speech.
   * @returns {boolean} True if speech is currently detected
   */
  public isCurrentlySpeaking(): boolean {
    return this.isSpeaking;
  }
}

export { VoiceConnectionHandler };