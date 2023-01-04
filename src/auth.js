const fs = require('fs');
const os = require('os');
const delay = require('delay');
const dotenv = require('dotenv');
const puppeteer = require('puppeteer-extra');
const RecaptchaPlugin = require('puppeteer-extra-plugin-recaptcha');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { Random } = require("random-js");
const random = new Random();

dotenv.config();
puppeteer.use(StealthPlugin())

let hasRecaptchaPlugin;
const DEFAULT_TIMEOUT_MS = 3 * 60 * 1000 // 3 minutes

async function getOpenAIAuth({
    email,
    password,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    isGoogleLogin = false,
    isMicrosoftLogin = false,
    captchaToken = process.env.CAPTCHA_TOKEN,
    executablePath,
    proxyServer = process.env.PROXY_SERVER,
    minimize = false
    }){
    let browser;
    try {

        browser = await getBrowser({
          captchaToken,
          executablePath,
          proxyServer,
          timeoutMs
        })
  
        const userAgent = await browser.userAgent()
    
        page = (await browser.pages())[0] || (await browser.newPage())
        page.setDefaultTimeout(timeoutMs)

        if (minimize) {
            await minimizePage(page)
        }
  
      await page.goto('https://chat.openai.com/auth/login', {
        waitUntil: 'networkidle2'
      })
  
      // NOTE: this is where you may encounter a CAPTCHA
      await checkForChatGPTAtCapacity(page, { timeoutMs })
  
      if (hasRecaptchaPlugin) {
        const captchas = await page.findRecaptchas()
  
        if (captchas?.filtered?.length) {
          console.log('solving captchas using 2captcha...')
          const res = await page.solveRecaptchas()
          console.log('captcha result', res)
        }
      }
  
      // once we get to this point, the Cloudflare cookies should be available
  
      // login as well (optional)
      if (email && password) {
        await waitForConditionOrAtCapacity(page, () =>
          page.waitForSelector('#__next .btn-primary', { timeout: timeoutMs })
        )
        await delay(500)
  
        // click login button and wait for navigation to finish
        do {
          await Promise.all([
            page.waitForNavigation({
              waitUntil: 'networkidle2',
              timeout: timeoutMs
            }),
            page.click('#__next .btn-primary')
          ])
          await delay(500)
        } while (page.url().endsWith('/auth/login'))
  
        await checkForChatGPTAtCapacity(page, { timeoutMs })
  
        let submitP;
  
        if (isGoogleLogin) {
          await page.waitForSelector('button[data-provider="google"]', {
            timeout: timeoutMs
          })
          await page.click('button[data-provider="google"]')
          await page.waitForSelector('input[type="email"]')
          await page.type('input[type="email"]', email, { delay: 10 })
          await Promise.all([
            page.waitForNavigation(),
            await page.keyboard.press('Enter')
          ])
          await page.waitForSelector('input[type="password"]', { visible: true })
          await page.type('input[type="password"]', password, { delay: 10 })
          submitP = () => page.keyboard.press('Enter')
        } else if (isMicrosoftLogin) {
          await page.click('button[data-provider="windowslive"]')
          await page.waitForSelector('input[type="email"]')
          await page.type('input[type="email"]', email, { delay: 10 })
          await Promise.all([
            page.waitForNavigation(),
            await page.keyboard.press('Enter')
          ])
          await delay(1500)
          await page.waitForSelector('input[type="password"]', { visible: true })
          await page.type('input[type="password"]', password, { delay: 10 })
          submitP = () => page.keyboard.press('Enter')
          await Promise.all([
            page.waitForNavigation(),
            await page.keyboard.press('Enter')
          ])
          await delay(1000)
        } else {
          await page.waitForSelector('#username')
          await page.type('#username', email)
          await delay(100)
  
          // NOTE: this is where you may encounter a CAPTCHA
          if (hasRecaptchaPlugin) {
            console.log('solving captchas using 2captcha...')
  
            // Add retries in case network is unstable
            const retries = 3
            for (let i = 0; i < retries; i++) {
              try {
                const res = await page.solveRecaptchas()
                if (res.captchas?.length) {
                  console.log('captchas result', res)
                  break
                } else {
                  console.log('no captchas found')
                  await delay(500)
                }
              } catch (e) {
                console.log('captcha error', e)
              }
            }
          }
  
          await delay(2000)
          const frame = page.mainFrame()
          const submit = await page.waitForSelector('button[type="submit"]', {
            timeout: timeoutMs
          })
          await frame.focus('button[type="submit"]')
          await submit.focus()
          await submit.click()
          await page.waitForSelector('#password', { timeout: timeoutMs })
          await page.type('#password', password, { delay: 10 })
          submitP = () => page.click('button[type="submit"]')
        }
  
        await Promise.all([
          waitForConditionOrAtCapacity(page, () =>
            page.waitForNavigation({
              waitUntil: 'networkidle2',
              timeout: timeoutMs
            })
          ),
          submitP()
        ])
      } else {
        await delay(2000)
        await checkForChatGPTAtCapacity(page, { timeoutMs })
      }
  
      const pageCookies = await page.cookies()
      const cookies = pageCookies.reduce(
        (map, cookie) => ({ ...map, [cookie.name]: cookie }),
        {}
      )
  
      const authInfo = {
        userAgent,
        clearanceToken: cookies['cf_clearance']?.value,
        sessionToken: cookies['__Secure-next-auth.session-token']?.value,
        cookies
      }
  
      return authInfo
    } catch (err) {
      throw err
    } finally {
      if (browser) {
        await browser.close()
      }
      page = null
      browser = null
    }
  }

  async function getBrowser(opts) {
    const {
      captchaToken = process.env.CAPTCHA_TOKEN,
      executablePath = defaultChromeExecutablePath(),
      proxyServer = process.env.PROXY_SERVER,
      minimize = false,
      timeoutMs = DEFAULT_TIMEOUT_MS,
      ...launchOptions
    } = opts
  
    if (captchaToken && !hasRecaptchaPlugin) {
      hasRecaptchaPlugin = true
      // console.log('use captcha', captchaToken)
  
      puppeteer.use(
        RecaptchaPlugin({
          provider: {
            id: '2captcha',
            token: captchaToken
          },
          visualFeedback: true // colorize reCAPTCHAs (violet = detected, green = solved)
        })
      )
    }
  
    // https://peter.sh/experiments/chromium-command-line-switches/
    const puppeteerArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-infobars',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--ignore-certificate-errors',
      '--no-first-run',
      '--no-service-autorun',
      '--password-store=basic',
      '--system-developer-mode',
      // the following flags all try to reduce memory
      // '--single-process',
      '--mute-audio',
      '--disable-default-apps',
      '--no-zygote',
      '--disable-accelerated-2d-canvas',
      '--disable-web-security'
      // '--disable-gpu'
      // '--js-flags="--max-old-space-size=1024"'
    ]
  
    if (proxyServer) {
      const ipPort = proxyServer.includes('@')
        ? proxyServer.split('@')[1]
        : proxyServer
      puppeteerArgs.push(`--proxy-server=${ipPort}`)
    }
  
    const browser = await puppeteer.launch({
      headless: false,
      // devtools: true,
      args: puppeteerArgs,
      ignoreDefaultArgs: [
        '--disable-extensions',
        '--enable-automation',
        '--disable-component-extensions-with-background-pages'
      ],
      ignoreHTTPSErrors: true,
      executablePath,
      ...launchOptions
    })
  
    if (process.env.PROXY_VALIDATE_IP) {
      const page = (await browser.pages())[0] || (await browser.newPage())
      if (minimize) {
        await minimizePage(page)
      }
  
      // Send a fetch request to https://ifconfig.co using page.evaluate() and
      // verify that the IP matches
      let ip;
      try {
        const res = await page.evaluate(() => {
          return fetch('https://ifconfig.co', {
            headers: {
              Accept: 'application/json'
            }
          }).then((res) => res.json())
        })
  
        ip = res?.ip
      } catch (err) {
        throw new Error(`Proxy IP validation failed: ${err.toString()}`)
      }
  
      if (!ip || ip !== process.env.PROXY_VALIDATE_IP) {
        throw new Error(
          `Proxy IP mismatch: ${ip} !== ${process.env.PROXY_VALIDATE_IP}`
        )
      }
    }

    return browser
}

async function minimizePage(page) {
const session = await page.target().createCDPSession()
const goods = await session.send('Browser.getWindowForTarget')
const { windowId } = goods
await session.send('Browser.setWindowBounds', {
    windowId,
    bounds: { windowState: 'minimized' }
})
}

async function maximizePage(page) {
    const session = await page.target().createCDPSession()
    const goods = await session.send('Browser.getWindowForTarget')
    const { windowId } = goods
    await session.send('Browser.setWindowBounds', {
      windowId,
      bounds: { windowState: 'normal' }
    })
}
async function checkForChatGPTAtCapacity(
    page,
    opts
  ) {
    
    let timeoutMs = 2 * 60 * 1000 // 2 minutes
    let pollingIntervalMs = 3000
    let retries = 10
    if (opts){
      if(opts.timeoutMs){
        timeoutMs = opts.timeoutMs
      }
      if(opts.pollingIntervalMs){
        pollingIntervalMs = opts.pollingIntervalMs
      }
      if(opts.retries){
        retries = opts.retries
      }
    }
    // console.log('checkForChatGPTAtCapacity', page.url())
    let isAtCapacity = false
    let numTries = 0
  
    do {
      try {
        await solveSimpleCaptchas(page)
  
        const res = await page.$x("//div[contains(., 'ChatGPT is at capacity')]")
        isAtCapacity = !!res?.length
  
        if (isAtCapacity) {
          if (++numTries >= retries) {
            break
          }
  
          // try refreshing the page if chatgpt is at capacity
          await page.reload({
            waitUntil: 'networkidle2',
            timeout: timeoutMs
          })
  
          await delay(pollingIntervalMs)
        }
      } catch (err) {
        // ignore errors likely due to navigation
        ++numTries
        break
      }
    } while (isAtCapacity)
  
    if (isAtCapacity) {
      const error = new types.ChatGPTError('ChatGPT is at capacity')
      error.statusCode = 503
      throw error
    }
  }
  
async function waitForConditionOrAtCapacity(
    page,
    condition,
    opts
  ) {
    let pollingIntervalMs = 500;
    if (opts && opts.pollingIntervalMs){
      pollingIntervalMs = opts.pollingIntervalMs;
    }
  
    return new Promise((resolve, reject) => {
      let resolved = false
  
      async function waitForCapacityText() {
        if (resolved) {
          return
        }
  
        try {
          await checkForChatGPTAtCapacity(page)
  
          if (!resolved) {
            setTimeout(waitForCapacityText, pollingIntervalMs)
          }
        } catch (err) {
          if (!resolved) {
            resolved = true
            return reject(err)
          }
        }
      }
  
      condition()
        .then(() => {
          if (!resolved) {
            resolved = true
            resolve()
          }
        })
        .catch((err) => {
          if (!resolved) {
            resolved = true
            reject(err)
          }
        })
  
      setTimeout(waitForCapacityText, pollingIntervalMs)
    })
}
async function solveSimpleCaptchas(page) {
    try {
      const verifyYouAreHuman = await page.$('text=Verify you are human')
      if (verifyYouAreHuman) {
        await delay(2000)
        await verifyYouAreHuman.click({
          delay: random.integer(5, 25)
        })
        await delay(1000)
      }
  
      const cloudflareButton = await page.$('.hcaptcha-box')
      if (cloudflareButton) {
        await delay(2000)
        await cloudflareButton.click({
          delay: random.integer(5, 25)
        })
        await delay(1000)
      }
    } catch (err) {
      // ignore errors
    }
}
const defaultChromeExecutablePath = () => {
    // return executablePath()
  
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
      return process.env.PUPPETEER_EXECUTABLE_PATH
    }
  
    switch (os.platform()) {
      case 'win32':
        return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  
      case 'darwin':
        return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  
      default: {
        /**
         * Since two (2) separate chrome releases exist on linux, we first do a
         * check to ensure we're executing the right one.
         */
        const chromeExists = fs.existsSync('/usr/bin/google-chrome')
  
        return chromeExists
          ? '/usr/bin/google-chrome'
          : '/usr/bin/google-chrome-stable'
      }
    }
  }
module.exports = {
    getOpenAIAuth,
    getBrowser,
    minimizePage,
    maximizePage,
    defaultChromeExecutablePath
}