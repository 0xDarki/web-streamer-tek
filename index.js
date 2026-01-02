const express = require('express');
const { spawn, execSync } = require('child_process');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const app = express();

// Try to use system FFmpeg first (if available via nixpacks), fallback to ffmpeg-static
let ffmpegPath;
try {
  // Check if system FFmpeg is available (from nixpacks)
  const { execSync } = require('child_process');
  try {
    execSync('which ffmpeg', { stdio: 'ignore' });
    ffmpegPath = 'ffmpeg'; // Use system FFmpeg
    console.log('Using system FFmpeg (from nixpacks)');
  } catch (e) {
    // System FFmpeg not available, use ffmpeg-static
    const ffmpegStatic = require('ffmpeg-static');
    ffmpegPath = ffmpegStatic;
    console.log('Using ffmpeg-static (fallback)');
  }
} catch (error) {
  // Fallback to ffmpeg-static if system FFmpeg check fails
  const ffmpegStatic = require('ffmpeg-static');
  ffmpegPath = ffmpegStatic;
  console.log('Using ffmpeg-static (fallback)');
}

const PORT = process.env.PORT || 3000;
const RTMPS_URL = process.env.RTMPS_URL;
const SOURCE_URL = process.env.SOURCE_URL;
const WEB_PAGE_URL = process.env.WEB_PAGE_URL;
const PLAY_BUTTON_SELECTOR = process.env.PLAY_BUTTON_SELECTOR || 'button[aria-label="Play"], button[aria-label="play"], button[aria-label*="play" i], .play-button, [class*="play"], button:has-text("Play")';
const FPS = parseInt(process.env.FPS) || 3; // Default 3 FPS (between 1-5)

// Note: Audio capture from browser pages in headless environment is very difficult
// PulseAudio cannot run on Railway without an audio system
// The audio from your website will play in the browser but cannot be captured
// For now, we use silent audio as a placeholder
console.log('Audio capture: Using silent audio (system audio capture not available in headless Railway environment)');

if (!RTMPS_URL) {
  console.error('RTMPS_URL environment variable is required');
  process.exit(1);
}

let currentStream = null;
let browser = null;
let page = null;
let captureProcess = null;
let streamStatus = { active: false, error: null };

// Helper function to replace deprecated waitForTimeout
function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    streaming: streamStatus.active,
    error: streamStatus.error 
  });
});

// Start streaming endpoint
app.post('/start', express.json(), async (req, res) => {
  const sourceUrl = req.body.url || SOURCE_URL;
  const webPageUrl = req.body.webPageUrl || WEB_PAGE_URL;
  const playButtonSelector = req.body.playButtonSelector || PLAY_BUTTON_SELECTOR;
  
  if (!sourceUrl && !webPageUrl) {
    return res.status(400).json({ error: 'Source URL or Web Page URL is required' });
  }

  if (streamStatus.active) {
    return res.status(400).json({ error: 'Stream is already active' });
  }

  try {
    if (webPageUrl) {
      // Stream from web page with auto-play click
      await startWebPageStream(webPageUrl, playButtonSelector);
      res.json({ 
        message: 'Web page stream started', 
        webPageUrl,
        playButtonSelector,
        rtmpsUrl: RTMPS_URL,
        fps: FPS
      });
    } else {
      // Stream from direct URL
      startStream(sourceUrl);
      res.json({ 
        message: 'Stream started', 
        sourceUrl,
        rtmpsUrl: RTMPS_URL,
        fps: FPS
      });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Stop streaming endpoint
app.post('/stop', async (req, res) => {
  if (!streamStatus.active) {
    return res.status(400).json({ error: 'No active stream' });
  }

  await stopStream();
  res.json({ message: 'Stream stopped' });
});

// Status endpoint
app.get('/status', (req, res) => {
  res.json(streamStatus);
});

async function startWebPageStream(webPageUrl, playButtonSelector) {
  console.log(`Starting web page stream from ${webPageUrl} to ${RTMPS_URL} at ${FPS} FPS`);
  console.log(`Looking for play button with selector: ${playButtonSelector}`);
  
  streamStatus.active = true;
  streamStatus.error = null;

  try {
    // Launch browser with audio capture support
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--window-size=1920,1080',
        '--autoplay-policy=no-user-gesture-required',
        '--enable-features=UseChromeOSDirectVideoDecoder',
        '--use-fake-ui-for-media-stream', // Allow audio capture
        '--use-fake-device-for-media-stream',
        '--allow-running-insecure-content'
      ]
    });

    page = await browser.newPage();
    
    // Set viewport to 1920x1080
    await page.setViewport({ width: 1920, height: 1080 });
    
    // Navigate to page
    console.log(`Navigating to ${webPageUrl}...`);
    await page.goto(webPageUrl, { 
      waitUntil: 'networkidle2',
      timeout: 30000 
    });

    // Wait a bit for page to load
    await wait(3000);

    // Try to click play button with multiple strategies
    let playClicked = false;
    
    // Split selector string and try each one
    const selectors = playButtonSelector.split(',').map(s => s.trim());
    
    for (const selector of selectors) {
      try {
        console.log(`Trying selector: ${selector}`);
        await page.waitForSelector(selector, { timeout: 5000 });
        await page.click(selector);
        console.log(`Play button clicked successfully with selector: ${selector}`);
        playClicked = true;
        await wait(1000); // Wait for audio to start
        break;
      } catch (error) {
        console.log(`Selector "${selector}" not found, trying next...`);
        continue;
      }
    }
    
    // If no selector worked, try alternative methods
    if (!playClicked) {
      console.log('No play button found with selectors, trying alternative methods...');
      
      // Try to find any button with "play" in text or aria-label
      try {
        const playButton = await page.evaluate(() => {
          // Try to find button by text content
          const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
          for (const btn of buttons) {
            const text = btn.textContent?.toLowerCase() || '';
            const ariaLabel = btn.getAttribute('aria-label')?.toLowerCase() || '';
            if (text.includes('play') || ariaLabel.includes('play')) {
              return true;
            }
          }
          return false;
        });
        
        if (playButton) {
          await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
            for (const btn of buttons) {
              const text = btn.textContent?.toLowerCase() || '';
              const ariaLabel = btn.getAttribute('aria-label')?.toLowerCase() || '';
              if (text.includes('play') || ariaLabel.includes('play')) {
                btn.click();
                return;
              }
            }
          });
          console.log('Play button clicked via JavaScript evaluation');
          await wait(1000);
        } else {
          // Last resort: click on body to enable autoplay
          console.log('Clicking on body to enable autoplay...');
          await page.evaluate(() => {
            document.body.click();
            // Also try to trigger any audio context
            if (window.AudioContext || window.webkitAudioContext) {
              const AudioContextClass = window.AudioContext || window.webkitAudioContext;
              const context = new AudioContextClass();
              context.resume();
            }
          });
          await wait(1000);
        }
      } catch (error) {
        console.warn('Alternative play button methods failed:', error.message);
      }
    }

    // Get Chrome DevTools Protocol client
    const client = await page.target().createCDPSession();
    
    // Enable necessary domains
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    await client.send('DOM.enable');
    
    // Start screen capture using CDP
    console.log('Starting screen capture via CDP...');
    await startBrowserCapture(client, page);
    
  } catch (error) {
    console.error('Error setting up web page stream:', error);
    streamStatus.active = false;
    streamStatus.error = error.message;
    if (browser) {
      await browser.close();
      browser = null;
    }
    throw error;
  }
}

async function startBrowserCapture(client, page) {
  // Use Chrome's screencast API to capture frames
  // We'll capture frames and pipe them to FFmpeg
  // Also capture audio via Web Audio API
  
  const frameInterval = 1000 / FPS; // milliseconds between frames
  let frameBuffer = [];
  let audioBuffer = [];
  
  // Store reference for cleanup
  const captureState = { isCapturing: true };
  
  // Set up audio capture via Web Audio API
  console.log('Setting up audio capture from page via Web Audio API...');
  
  // Expose a function to the page to send audio data
  let audioDataReceived = false;
  let audioChunksReceived = 0;
  
  await page.exposeFunction('sendAudioData', (audioData) => {
    try {
      // audioData is already an object (Puppeteer handles serialization)
      if (audioData && audioData.data && Array.isArray(audioData.data)) {
        // Convert Float32Array to PCM16 (16-bit signed integers)
        const pcmData = new Int16Array(audioData.data.length);
        for (let i = 0; i < audioData.data.length; i++) {
          // Clamp and convert float (-1.0 to 1.0) to int16 (-32768 to 32767)
          const sample = Math.max(-1, Math.min(1, audioData.data[i]));
          pcmData[i] = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
        }
        // Add to audio buffer
        audioBuffer.push(Buffer.from(pcmData.buffer));
        audioDataReceived = true;
        audioChunksReceived++;
        if (audioChunksReceived % 100 === 0) {
          console.log(`Received ${audioChunksReceived} audio chunks from page`);
        }
      }
    } catch (error) {
      console.error('Error processing audio data:', error);
    }
  });
  
  // Inject script to capture audio from the page
  await page.evaluateOnNewDocument(() => {
    // This runs in the page context before page load
    (async () => {
      // Wait for page to be ready
      if (document.readyState === 'loading') {
        await new Promise(resolve => {
          if (document.readyState === 'complete') {
            resolve();
          } else {
            document.addEventListener('DOMContentLoaded', resolve);
          }
        });
      }
      
      // Wait a bit more for audio elements to load
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Function to capture audio from an element
      const captureAudioFromElement = async (element) => {
        try {
          if (!window.AudioContext && !window.webkitAudioContext) {
            console.log('Web Audio API not available');
            return;
          }
          
          const AudioContextClass = window.AudioContext || window.webkitAudioContext;
          const audioContext = new AudioContextClass({ sampleRate: 22050 });
          
          // Resume audio context (required for autoplay)
          if (audioContext.state === 'suspended') {
            await audioContext.resume();
          }
          
          // Create source from media element
          const source = audioContext.createMediaElementSource(element);
          
          // Create script processor to capture audio data
          const bufferSize = 4096;
          const processor = audioContext.createScriptProcessor(bufferSize, 2, 2);
          
          // Connect: source -> processor -> destination
          source.connect(processor);
          processor.connect(audioContext.destination);
          
          // Capture audio data
          processor.onaudioprocess = (e) => {
            const inputData = e.inputBuffer;
            const leftChannel = inputData.getChannelData(0);
            const rightChannel = inputData.getChannelData(1);
            
            // Interleave stereo channels
            const interleaved = new Float32Array(leftChannel.length * 2);
            for (let i = 0; i < leftChannel.length; i++) {
              interleaved[i * 2] = leftChannel[i];
              interleaved[i * 2 + 1] = rightChannel[i];
            }
            
            // Send to Node.js via exposed function
            try {
              if (typeof window.sendAudioData === 'function') {
                window.sendAudioData({
                  data: Array.from(interleaved),
                  sampleRate: audioContext.sampleRate
                });
              }
            } catch (err) {
              // Ignore errors - function may not be ready yet
            }
          };
          
          console.log('Audio capture started for element');
        } catch (error) {
          console.log('Error setting up audio capture:', error);
        }
      };
      
      // Try to capture from existing audio/video elements
      const setupAudioCapture = () => {
        const mediaElements = document.querySelectorAll('audio, video');
        console.log(`Found ${mediaElements.length} audio/video elements`);
        
        if (mediaElements.length === 0) {
          console.log('No audio/video elements found, will try to capture from Web Audio API context');
          // Try to capture from any active AudioContext
          try {
            if (window.AudioContext || window.webkitAudioContext) {
              const AudioContextClass = window.AudioContext || window.webkitAudioContext;
              // Try to find any active audio sources
              console.log('Web Audio API available, but no media elements found');
            }
          } catch (e) {
            console.log('Could not access Web Audio API:', e);
          }
        }
        
        mediaElements.forEach((element, index) => {
          console.log(`Processing element ${index + 1}:`, element.tagName, element.src || element.srcObject ? 'has source' : 'no source');
          
          if (element.src || element.srcObject) {
            // Wait for element to be ready
            element.addEventListener('loadedmetadata', () => {
              console.log(`Element ${index + 1} metadata loaded, starting capture`);
              captureAudioFromElement(element);
            });
            
            // Also try immediately if already loaded
            if (element.readyState >= 2) {
              console.log(`Element ${index + 1} already loaded, starting capture immediately`);
              captureAudioFromElement(element);
            }
          } else {
            console.log(`Element ${index + 1} has no source, skipping`);
          }
        });
      };
      
      // Run immediately and also on DOM changes
      setupAudioCapture();
      
      // Watch for new audio/video elements
      const observer = new MutationObserver(() => {
        setupAudioCapture();
      });
      if (document.body) {
        observer.observe(document.body, { childList: true, subtree: true });
      }
      
      // Also try after delays to catch dynamically loaded elements
      setTimeout(setupAudioCapture, 3000);
      setTimeout(setupAudioCapture, 5000);
      setTimeout(setupAudioCapture, 10000);
      
      // Also try Web Audio API capture as fallback
      setTimeout(tryCaptureFromWebAudio, 5000);
    })();
  });
  
  // Also inject audio capture script after page is fully loaded
  // This ensures we catch audio that starts playing after page load
  try {
    await page.evaluate(() => {
      // Re-run audio capture setup after page load
      if (typeof setupAudioCapture === 'function') {
        setupAudioCapture();
      }
    });
    console.log('Audio capture script injected after page load');
  } catch (error) {
    console.log('Could not inject audio capture script after page load:', error.message);
  }
  
  // Start screencast with JPEG format (more stable than PNG)
  await client.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 80,
    maxWidth: 1920,
    maxHeight: 1080,
    everyNthFrame: Math.max(1, Math.floor(30 / FPS)) // Adjust based on FPS
  });
  
  console.log('Screencast started, waiting for first frame...');
  
  // Wait for first frame before starting FFmpeg
  let firstFrameReceived = false;
  const firstFramePromise = new Promise((resolve) => {
    const frameHandler = async (frame) => {
      if (!firstFrameReceived) {
        firstFrameReceived = true;
        try {
          const buffer = Buffer.from(frame.data, 'base64');
          frameBuffer.push(buffer);
          await client.send('Page.screencastFrameAck', { sessionId: frame.sessionId });
          console.log('First frame received, starting FFmpeg...');
          resolve();
        } catch (error) {
          console.error('Error processing first frame:', error);
          resolve(); // Continue anyway
        }
      }
    };
    client.once('Page.screencastFrame', frameHandler);
    // Timeout after 5 seconds
    setTimeout(() => {
      if (!firstFrameReceived) {
        console.warn('No frame received after 5 seconds, starting FFmpeg anyway...');
        resolve();
      }
    }, 5000);
  });
  
  // Listen for screencast frames
  client.on('Page.screencastFrame', async (frame) => {
    if (!captureState.isCapturing) return;
    
    try {
      // Decode the base64 frame
      const buffer = Buffer.from(frame.data, 'base64');
      frameBuffer.push(buffer);
      
      // Acknowledge frame
      await client.send('Page.screencastFrameAck', { sessionId: frame.sessionId });
    } catch (error) {
      console.error('Error processing frame:', error);
    }
  });
  
  // Wait for first frame
  await firstFramePromise;
  
  // Start FFmpeg process to encode frames and stream
  console.log('Starting FFmpeg encoding process...');
  console.log(`FFmpeg path: ${ffmpegPath}`);
  console.log(`RTMPS URL: ${RTMPS_URL}`);
  
  // Set up audio capture via Web Audio API
  // For now, use silent audio by default to avoid FFmpeg blocking
  // Audio capture from page can be added later if needed
  // The issue is that FFmpeg blocks if the audio pipe is empty
  
  // Create a named pipe (FIFO) for audio data (for future use)
  const audioPipePath = path.join('/tmp', `audio_${Date.now()}.pipe`);
  let audioPipe = null;
  let useAudioCapture = false;
  
  // Store pipe path for cleanup
  streamStatus.audioPipePath = null; // Don't use pipe for now to avoid blocking
  
  // For now, always use silent audio to ensure video streams properly
  // Audio capture from page requires more complex setup to avoid blocking
  let audioInputArgs = ['-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=22050'];
  console.log('Using silent audio (audio capture from page requires additional setup to avoid FFmpeg blocking)');
  
  // Optional: Try to set up audio pipe for future use (but don't use it in FFmpeg yet)
  try {
    execSync(`mkfifo ${audioPipePath}`, { stdio: 'ignore' });
    audioPipe = fs.createWriteStream(audioPipePath, { flags: 'w' });
    console.log('Audio pipe created for future use:', audioPipePath);
    captureState.audioCapturing = true;
    // Store path but don't use it in FFmpeg to avoid blocking
    streamStatus.audioPipePath = audioPipePath;
  } catch (error) {
    // Ignore - we're using silent audio anyway
  }
  
  // Optimized configuration for RTMPS streaming
  // Simplified approach to avoid SIGSEGV crashes
  const ffmpegArgs = [
    '-f', 'image2pipe',
    '-vcodec', 'mjpeg',
    '-framerate', FPS.toString(),
    '-i', '-',
    ...audioInputArgs,
    // Simplified filter chain - scale first, then format conversion
    '-vf', `scale=640:-1:flags=fast_bilinear,fps=${FPS},format=yuv420p`,
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-profile:v', 'baseline',
    '-level', '3.0',
    '-pix_fmt', 'yuv420p',
    '-g', '10',
    '-b:v', '500k',
    '-maxrate', '500k',
    '-bufsize', '1000k',
    '-r', FPS.toString(),
    '-c:a', 'aac',
    '-b:a', '64k',
    '-ar', '22050',
    '-ac', '2',
    '-f', 'flv',
    '-flvflags', 'no_duration_filesize',
    // RTMPS/TLS options
    '-protocol_whitelist', 'file,http,https,tcp,tls,rtmp,rtmps',
    '-tls_verify', '0', // Disable TLS certificate verification (may help with connection issues)
    '-loglevel', 'info',
    RTMPS_URL
  ];
  
  console.log('FFmpeg command:', ffmpegPath, ffmpegArgs.join(' '));
  
  captureProcess = spawn(ffmpegPath, ffmpegArgs);
  
  // Audio capture from page is disabled for now to avoid FFmpeg blocking
  // FFmpeg uses silent audio (anullsrc) so video can stream properly
  // Audio capture can be re-enabled later with proper non-blocking setup
  console.log('Audio capture from page is disabled - using silent audio to ensure video streams');
  console.log('Note: Video should now stream properly. Audio capture requires additional setup.');
  
  // Handle stdin errors to prevent EPIPE crashes
  if (captureProcess.stdin) {
    captureProcess.stdin.on('error', (error) => {
      if (error.code !== 'EPIPE') {
        console.error('FFmpeg stdin error:', error);
      }
      // EPIPE is expected when FFmpeg closes, so we ignore it
    });
  }
  
  // Collect all stderr output for debugging
  let ffmpegStderr = '';
  
  // Handle FFmpeg output
  captureProcess.stderr.on('data', (data) => {
    const output = data.toString();
    ffmpegStderr += output;
    // Log all FFmpeg output for debugging
    if (output.trim()) {
      console.log('FFmpeg:', output.trim());
    }
    if (output.includes('error') || output.includes('Error') || output.includes('failed')) {
      console.error('FFmpeg error detected:', output);
    }
  });
  
  captureProcess.on('error', (error) => {
    console.error('FFmpeg process error:', error);
    streamStatus.active = false;
    streamStatus.error = error.message;
    captureState.isCapturing = false;
  });
  
  captureProcess.on('exit', (code, signal) => {
    console.log(`FFmpeg process exited with code ${code}, signal ${signal}`);
    if (ffmpegStderr) {
      console.log('FFmpeg stderr output:', ffmpegStderr);
    }
    captureState.isCapturing = false;
    streamStatus.active = false;
    
    if (signal === 'SIGSEGV') {
      const errorMsg = 'FFmpeg crashed with SIGSEGV. This version of ffmpeg-static may not have proper RTMPS support compiled with OpenSSL. The build uses GnuTLS which can cause RTMPS connection issues.';
      console.error(errorMsg);
      streamStatus.error = errorMsg;
    } else if (code !== 0 && code !== null) {
      streamStatus.error = `FFmpeg exited with code ${code}`;
    }
  });
  
  // Wait a bit for FFmpeg to initialize and connect to RTMPS
  console.log('Waiting for FFmpeg to initialize RTMPS connection...');
  await wait(2000);
  
  // Pipe frames to FFmpeg with proper rate limiting
  let framesSent = 0;
  const sendFrames = () => {
    if (!captureState.isCapturing || !captureProcess || captureProcess.killed) {
      return;
    }
    
    if (frameBuffer.length > 0) {
      const frame = frameBuffer.shift();
      if (captureProcess.stdin && !captureProcess.stdin.destroyed) {
        try {
          const success = captureProcess.stdin.write(frame);
          framesSent++;
          if (framesSent % 10 === 0) {
            console.log(`Sent ${framesSent} frames to FFmpeg`);
          }
          
          if (!success) {
            // Wait for drain if buffer is full
            captureProcess.stdin.once('drain', () => {
              if (captureState.isCapturing) {
                setTimeout(sendFrames, frameInterval);
              }
            });
            return;
          }
        } catch (error) {
          // EPIPE is expected when FFmpeg closes, ignore it
          if (error.code !== 'EPIPE') {
            console.error('Error writing frame to FFmpeg:', error);
          }
          captureState.isCapturing = false;
          return;
        }
      }
    }
    
    if (captureState.isCapturing) {
      setTimeout(sendFrames, frameInterval);
    }
  };
  
  // Start sending frames
  console.log('Starting to send frames to FFmpeg...');
  sendFrames();
  
  // Try to capture audio from the page
  // Note: This is a workaround - real audio capture from browser requires more complex setup
  // For now, we use silent audio. To capture real audio, you'd need to use Chrome's audio capture
  // or pipe audio from the browser process, which is more complex on Railway.
  
  console.log('Browser capture started - streaming frames to RTMPS');
  
  // Keep page alive and periodically check if audio is playing
  const keepAliveInterval = setInterval(async () => {
    if (!captureState.isCapturing || !page) {
      clearInterval(keepAliveInterval);
      return;
    }
    
    try {
      // Check if audio is playing (this helps keep the page responsive)
      await page.evaluate(() => {
        // Trigger any audio context if needed
        if (window.AudioContext || window.webkitAudioContext) {
          // Audio context exists, page should handle it
        }
      });
    } catch (error) {
      // Ignore errors in audio check
    }
  }, 5000);
  
  // Store capture state for cleanup
  streamStatus.captureState = captureState;
}

function startStream(sourceUrl) {
  console.log(`Starting stream from ${sourceUrl} to ${RTMPS_URL} at ${FPS} FPS`);
  
  streamStatus.active = true;
  streamStatus.error = null;

  // Optimized FFmpeg command for low resource usage
  const ffmpegArgs = [
    '-re', // Read input at native frame rate
    '-rtsp_transport', 'tcp', // Use TCP for RTSP if applicable
    '-fflags', 'nobuffer', // Reduce buffering
    '-flags', 'low_delay', // Low latency
    '-strict', 'experimental',
    '-i', sourceUrl, // Input source
    '-c:v', 'libx264', // Video codec
    '-vf', `fps=${FPS},scale=640:-1`, // Video filters: FPS and scale
    '-preset', 'ultrafast', // Fastest encoding (lowest CPU)
    '-tune', 'zerolatency', // Zero latency
    '-profile:v', 'baseline', // Baseline profile (most compatible, lighter)
    '-level', '3.0', // H.264 level
    '-pix_fmt', 'yuv420p', // Pixel format
    '-g', '10', // GOP size (keyframe interval)
    '-b:v', '500k', // Video bitrate (low for resource efficiency)
    '-maxrate', '500k',
    '-bufsize', '1000k',
    '-r', FPS.toString(), // Output frame rate
    '-c:a', 'aac', // Audio codec
    '-b:a', '64k', // Low audio bitrate
    '-ar', '22050', // Lower sample rate (lighter)
    '-ac', '2', // Stereo
    '-f', 'flv', // FLV format for RTMPS
    '-flvflags', 'no_duration_filesize', // Optimize FLV
    '-protocol_whitelist', 'file,http,https,tcp,tls,rtmp,rtmps',
    '-rtmp_live', 'live',
    RTMPS_URL // Output URL
  ];

  console.log('FFmpeg command: ' + ffmpegPath + ' ' + ffmpegArgs.join(' '));
  
  currentStream = spawn(ffmpegPath, ffmpegArgs);
  
  // Handle FFmpeg output
  currentStream.stderr.on('data', (data) => {
    const output = data.toString();
    if (output.includes('error') || output.includes('Error')) {
      console.error('FFmpeg error:', output);
    }
  });
  
  currentStream.on('error', (error) => {
    console.error('FFmpeg process error:', error);
    streamStatus.active = false;
    streamStatus.error = error.message;
    currentStream = null;
  });
  
  currentStream.on('exit', (code) => {
    console.log(`FFmpeg process exited with code ${code}`);
    streamStatus.active = false;
    currentStream = null;
  });
}

async function stopStream() {
  // Stop capture state
  if (streamStatus.captureState) {
    streamStatus.captureState.isCapturing = false;
  }
  
  if (currentStream) {
    console.log('Stopping stream...');
    currentStream.kill('SIGTERM');
    currentStream = null;
  }
  
  if (captureProcess && !captureProcess.killed) {
    console.log('Stopping capture process...');
    try {
      captureProcess.kill('SIGTERM');
      // Wait a bit for graceful shutdown
      await new Promise(resolve => setTimeout(resolve, 1000));
      if (!captureProcess.killed) {
        captureProcess.kill('SIGKILL');
      }
    } catch (error) {
      console.error('Error stopping capture process:', error);
    }
    captureProcess = null;
  }
  
  // Stop screencast if page exists
  if (page) {
    try {
      const client = await page.target().createCDPSession();
      await client.send('Page.stopScreencast');
      await client.detach();
    } catch (error) {
      console.warn('Error stopping screencast:', error.message);
    }
  }
  
  if (browser) {
    console.log('Closing browser...');
    await browser.close();
    browser = null;
    page = null;
  }
  
  streamStatus.active = false;
  streamStatus.error = null;
  streamStatus.captureState = null;
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, stopping stream...');
  await stopStream();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, stopping stream...');
  await stopStream();
  process.exit(0);
});

// Auto-start if SOURCE_URL or WEB_PAGE_URL is provided
if (WEB_PAGE_URL) {
  console.log('WEB_PAGE_URL detected, starting web page stream automatically...');
  setTimeout(async () => {
    try {
      await startWebPageStream(WEB_PAGE_URL, PLAY_BUTTON_SELECTOR);
    } catch (error) {
      console.error('Failed to start web page stream:', error);
    }
  }, 2000);
} else if (SOURCE_URL) {
  console.log('SOURCE_URL detected, starting stream automatically...');
  setTimeout(() => startStream(SOURCE_URL), 1000);
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`RTMPS URL: ${RTMPS_URL}`);
  console.log(`Target FPS: ${FPS}`);
});

