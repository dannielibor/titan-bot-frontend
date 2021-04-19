import { Howl } from 'howler'
import { Cookie } from 'tough-cookie'
import SuccessEffect from '@/assets/success.mp3'

import StopWatch from 'statman-stopwatch'
import moment from 'moment-timezone'
import Toastify from 'toastify-js'
import 'toastify-js/src/toastify.css'

import authApi from '@/api/magento/titan22/auth'
import customerApi from '@/api/magento/titan22/customer'
import cartApi from '@/api/magento/titan22/cart'
import orderApi from '@/api/magento/titan22/order'
import productApi from '@/api/magento/titan22/product'

import Constant from '@/config/constant'
import Config from '@/config/app'
import store from '@/store/index'
import Bot from '@/services/task'
import Webhook from '@/services/webhook'
import CF from '@/services/cloudflare-bypass'
import CreditCardCheckout from '@/services/Titan22/CreditCardCheckout'
import PayMayaCheckout from '@/services/Titan22/PayMayaCheckout'

const Tasks = store._modules.root._children.task.context
const Settings = store._modules.root._children.settings.context
const Accounts = store._modules.root._children.account.context

/**
 * ===============================================
 * Automate service
 * ===============================================
 *
 * Provides automation actions
 *
 * ===============================================
 */
export default {
  /**
   * Remove task timer
   *
   * @param {*} id
   */
  async removeTimer (id) {
    const task = await Bot.getCurrentTask(id)

    if (task) {
      task.placeOrder = null

      Tasks.dispatch('updateItem', task)
    }
  },

  /**
   * Set address object
   *
   * @param {*} address
   * @param {*} email
   */
  setAddresses (address, email) {
    return {
      region: address.region.region,
      region_id: address.region_id,
      region_code: address.region.region_code,
      country_id: address.country_id,
      street: address.street,
      postcode: address.postcode,
      city: address.city,
      firstname: address.firstname,
      lastname: address.lastname,
      email: email,
      telephone: address.telephone
    }
  },

  /**
   * Check if token is expired
   *
   * @param {*} id
   */
  async checkTokenExpiration (id) {
    let currentTask = await Bot.getCurrentTask(id)
    if (!Bot.isRunning(id) || !currentTask) return false

    if (moment().isSameOrAfter(moment(currentTask.transactionData.token.expires_in))) {
      const token = await this.authenticate(id)
      currentTask = await Bot.getCurrentTask(id)

      if (Bot.isRunning(id) && token && Object.keys(token).length && currentTask) {
        currentTask.transactionData.token = token
        Tasks.dispatch('updateItem', currentTask)
      }
    }
  },

  /**
   * Assign config
   *
   * @param {*} proxy
   */
  getConfig (proxy) {
    let index = 0

    if (proxy.configs.length > 1) index = Math.floor(Math.random() * proxy.configs.length)

    return proxy.configs[index]
  },

  /**
   * Handle API error responses
   *
   * @param {*} id
   * @param {*} counter
   * @param {*} response
   * @param {*} attr
   */
  async handleError (id, counter, response, attr = 'orange') {
    try {
      try {
        if (response.statusCode && (response.statusCode === 503 || response.statusCode === 403)) {
          await Bot.updateCurrentTaskLog(id, `#${counter}: Bypassing bot protection...`)
        } else {
          await Bot.updateCurrentTaskLog(id, `#${counter} at Line 122: ${response.message}`)
        }
      } catch (error) {
        await Bot.updateCurrentTaskLog(id, `#${counter} at Line 125: ${error}`)
      }

      if (response.statusCode) {
        await Bot.setCurrentTaskStatus(id, { status: Constant.STATUS.RUNNING, msg: response.statusCode, attr: 'red' })

        switch (response.statusCode) {
          case 401:
            {
              if (!Bot.isRunning(id)) break

              let currentTask = await Bot.getCurrentTask(id)

              let interval = null
              let timeout = null
              await new Promise((resolve) => {
                interval = setInterval(() => {
                  timeout = setTimeout(() => {
                    clearInterval(interval)
                    resolve()
                  }, currentTask.delay)
                }, 500)
              })
              clearInterval(interval)
              clearTimeout(timeout)

              const token = await this.authenticate(id, attr)
              currentTask = await Bot.getCurrentTask(id)

              if (Bot.isRunning(id) && token && Object.keys(token).length && currentTask) {
                currentTask.transactionData.token = token
                Tasks.dispatch('updateItem', currentTask)
              }
            }
            break

          case 403:
          case 503:
            {
              await Bot.setCurrentTaskStatus(id, { status: Constant.STATUS.RUNNING, msg: 'Bypassing', attr })

              const { options } = response
              const { jar } = options

              const cookies = await CF.bypass(options, id, 'TASK')

              const currentTask = await Bot.getCurrentTask(id)

              if (cookies.length) {
                for (const cookie of cookies) {
                  const { name, value, expires, domain, path } = cookie

                  const expiresDate = new Date(expires * 1000)

                  const val = new Cookie({
                    key: name,
                    value,
                    expires: expiresDate,
                    domain: domain.startsWith('.') ? domain.substring(1) : domain,
                    path
                  }).toString()

                  jar.setCookie(val, options.headers.referer)
                }

                let configs = currentTask.proxy.configs.slice()

                configs = await configs.map((el) => {
                  if (el.proxy === options.proxy) el.options = options

                  return el
                })

                currentTask.proxy.configs = configs

                Tasks.state.items.forEach((el) => {
                  if (el.id !== id && el.proxy.id === currentTask.proxy.id) {
                    Tasks.dispatch('updateItem', {
                      ...el,
                      proxy: {
                        ...el.proxy,
                        configs: configs
                      }
                    })
                  }
                })
              }

              Tasks.dispatch('updateItem', { ...currentTask })
            }
            break
        }
      } else {
        await Bot.setCurrentTaskStatus(id, { status: Constant.STATUS.RUNNING, msg: 'error', attr: 'red' })
      }
    } catch (error) {
      await Bot.updateCurrentTaskLog(id, `#${counter} at Line 221: ${error}`)
    }
  },

  /**
   * Perform verify automation
   *
   * @param {*} id
   */
  async verify (id) {
    let currentTask = await Bot.getCurrentTask(id)
    if (!Bot.isRunning(id) || !currentTask) return false

    /**
     * Step 1: authenticate
     *
     * get user token
     */
    const token = await this.authenticate(id, 'cyan')

    currentTask = await Bot.getCurrentTask(id)
    if (!Bot.isRunning(id) || !currentTask) return false

    if (token) {
      currentTask.transactionData.token = token
      await Tasks.dispatch('updateItem', currentTask)
    } else {
      await new Promise(resolve => setTimeout(resolve, 1000))
      this.verify(id)
      return false
    }

    if (!Bot.isRunning(id)) return false

    await this.checkTokenExpiration(id)

    if (!Bot.isRunning(id)) return false

    /**
     * Step 2: get account
     *
     * get account data
     */
    const account = await this.prepareAccount(id, 'cyan')

    currentTask = await Bot.getCurrentTask(id)
    if (!Bot.isRunning(id) || !currentTask) return false

    if (account && Object.keys(account).length) {
      currentTask.transactionData.account = account
      await Tasks.dispatch('updateItem', currentTask)
    } else {
      await new Promise(resolve => setTimeout(resolve, 1000))
      this.verify(id)
      return false
    }

    if (!Bot.isRunning(id)) return false

    await this.checkTokenExpiration(id)

    if (!Bot.isRunning(id)) return false

    /**
     * Step 3: initialize cart
     *
     * create, get, and clean cart
     */
    const cart = await this.initializeCart(id, 'cyan')

    currentTask = await Bot.getCurrentTask(id)
    if (!Bot.isRunning(id) || !currentTask) return false

    if (cart && cart.id) {
      currentTask.transactionData.cart = cart
      await Tasks.dispatch('updateItem', currentTask)
      await Bot.updateCurrentTaskLog(id, 'Ready!')
      Bot.setCurrentTaskStatus(id, { status: Constant.STATUS.STOPPED, msg: 'ready', attr: 'light-blue' })
    } else {
      await new Promise(resolve => setTimeout(resolve, 1000))
      this.verify(id)
    }

    return false
  },

  /**
   * Perform start automation
   *
   * @param {*} id
   */
  async start (id) {
    let currentTask = await Bot.getCurrentTask(id)
    if (!Bot.isRunning(id) || !currentTask) return false

    /**
     * Step 1: authenticate
     *
     * get user token
     */
    let token = null

    if (currentTask.transactionData.token) {
      token = currentTask.transactionData.token
    } else {
      token = await this.authenticate(id)
    }

    currentTask = await Bot.getCurrentTask(id)
    if (!Bot.isRunning(id) || !currentTask) return false

    if (token && Object.keys(token).length) {
      currentTask.transactionData.token = token
      await Tasks.dispatch('updateItem', currentTask)
    } else {
      await new Promise(resolve => setTimeout(resolve, 1000))
      this.start(id)
      return false
    }

    currentTask = await Bot.getCurrentTask(id)
    if (!Bot.isRunning(id) || !currentTask) return false

    await this.checkTokenExpiration(id)

    currentTask = await Bot.getCurrentTask(id)
    if (!Bot.isRunning(id) || !currentTask) return false

    /**
     * Step 2: get account
     *
     * get account data
     */
    let account = null

    if (currentTask.transactionData.account && Object.keys(currentTask.transactionData.account).length) {
      account = currentTask.transactionData.account
    } else {
      account = await this.prepareAccount(id)
    }

    currentTask = await Bot.getCurrentTask(id)
    if (!Bot.isRunning(id) || !currentTask) return false

    if (account && Object.keys(account).length) {
      currentTask.transactionData.account = account
      await Tasks.dispatch('updateItem', currentTask)
    } else {
      await new Promise(resolve => setTimeout(resolve, 1000))
      this.start(id)
      return false
    }

    currentTask = await Bot.getCurrentTask(id)
    if (!Bot.isRunning(id) || !currentTask) return false

    await this.checkTokenExpiration(id)

    currentTask = await Bot.getCurrentTask(id)
    if (!Bot.isRunning(id) || !currentTask) return false

    /**
     * Step 3: initialize cart
     *
     * create, get, and clean cart
     */
    let cart = null

    if (currentTask.transactionData.cart && currentTask.transactionData.cart.id) {
      cart = currentTask.transactionData.cart
    } else {
      cart = await this.initializeCart(id)
    }

    currentTask = await Bot.getCurrentTask(id)
    if (!Bot.isRunning(id) || !currentTask) return false

    if (cart && cart.id) {
      currentTask.transactionData.cart = cart
      await Tasks.dispatch('updateItem', currentTask)
    } else {
      await new Promise(resolve => setTimeout(resolve, 1000))
      this.start(id)
      return false
    }

    currentTask = await Bot.getCurrentTask(id)
    if (!Bot.isRunning(id) || !currentTask) return false

    await this.checkTokenExpiration(id)

    currentTask = await Bot.getCurrentTask(id)
    if (!Bot.isRunning(id) || !currentTask) return false

    /**
     * Step 4: add to cart
     *
     * add to cart
     */
    const product = await this.addToCart(id)

    currentTask = await Bot.getCurrentTask(id)
    if (!Bot.isRunning(id) || !currentTask) return false

    if (product && Object.keys(product).length) {
      currentTask.transactionData.product = product
      await Tasks.dispatch('updateItem', currentTask)
    } else {
      await new Promise(resolve => setTimeout(resolve, 1000))
      this.start(id)
      return false
    }

    currentTask = await Bot.getCurrentTask(id)
    if (!Bot.isRunning(id) || !currentTask) return false

    await this.checkTokenExpiration(id)

    currentTask = await Bot.getCurrentTask(id)
    if (!Bot.isRunning(id) || !currentTask) return false

    /**
     * Step 5: set shipping info
     *
     * set shipping details
     */
    const shipping = await this.setShippingInfo(id)

    currentTask = await Bot.getCurrentTask(id)
    if (!Bot.isRunning(id) || !currentTask) return false

    if (shipping && Object.keys(shipping).length) {
      currentTask.transactionData.shipping = shipping
      await Tasks.dispatch('updateItem', currentTask)
    } else {
      await new Promise(resolve => setTimeout(resolve, 1000))
      this.start(id)
      return false
    }

    currentTask = await Bot.getCurrentTask(id)
    if (!Bot.isRunning(id) || !currentTask) return false

    await this.checkTokenExpiration(id)

    currentTask = await Bot.getCurrentTask(id)
    if (!Bot.isRunning(id) || !currentTask) return false

    /**
     * Step 6: place order
     *
     * place order
     */
    const order = await this.placeOrder(id)

    currentTask = await Bot.getCurrentTask(id)
    if (!Bot.isRunning(id) || !currentTask) return false

    if (order) {
      await this.onSuccess(id)
      return false
    } else {
      delete currentTask.transactionData.cart

      await Tasks.dispatch('updateItem', currentTask)

      await new Promise(resolve => setTimeout(resolve, 1000))
      this.start(id)
    }

    return false
  },

  /**
   * Perform login
   *
   * @param {*} id
   */
  async authenticate (id, attr = 'orange') {
    let data = null
    let counter = 0

    while (Bot.isRunning(id) && !data) {
      counter++

      try {
        let currentTask = await Bot.getCurrentTask(id)
        if (!Bot.isRunning(id) || !currentTask) break

        if (counter > 1) {
          let interval = null
          let timeout = null
          await new Promise((resolve) => {
            interval = setInterval(() => {
              timeout = setTimeout(() => {
                clearInterval(interval)
                resolve()
              }, currentTask.delay)
            }, 500)
          })
          clearInterval(interval)
          clearTimeout(timeout)
        }

        currentTask = await Bot.getCurrentTask(id)
        if (!Bot.isRunning(id) || !currentTask) break

        await Bot.setCurrentTaskStatus(id, { status: Constant.STATUS.RUNNING, msg: 'authenticating', attr: attr })
        await Bot.updateCurrentTaskLog(id, `#${counter}: Logging in...`)

        const params = {
          payload: {
            username: currentTask.account.email,
            password: currentTask.account.password
          },
          mode: currentTask.mode,
          config: this.getConfig(currentTask.proxy),
          taskId: currentTask.id
        }

        if (!Bot.isRunning(id)) break

        const response = await authApi.fetchToken(params)

        if (!Bot.isRunning(id)) break

        if (response && response.error) {
          await this.handleError(id, counter, response.error, attr)
          continue
        } else if (response && !response.error) {
          data = {
            token: JSON.parse(response),
            expires_in: moment().add(50, 'minutes').toISOString()
          }

          break
        }
      } catch (error) {
        await Bot.updateCurrentTaskLog(id, `#${counter} at Line 559: ${error}`)
        continue
      }
    }

    return data
  },

  /**
   * Prepare user account
   *
   * @param {*} id
   * @param {*} attr
   * @returns
   */
  async prepareAccount (id, attr = 'orange') {
    const account = await this.getAccount(id, attr)

    await this.updateAccount(id, attr, account)

    return account
  },

  /**
   * Fetch user account
   *
   * @param {*} id
   */
  async getAccount (id, attr = 'orange') {
    let data = null
    let counter = 0

    while (Bot.isRunning(id) && !data) {
      counter++

      try {
        let currentTask = await Bot.getCurrentTask(id)
        if (!Bot.isRunning(id) || !currentTask) break

        if (counter > 1) {
          let interval = null
          let timeout = null
          await new Promise((resolve) => {
            interval = setInterval(() => {
              timeout = setTimeout(() => {
                clearInterval(interval)
                resolve()
              }, currentTask.delay)
            }, 500)
          })
          clearInterval(interval)
          clearTimeout(timeout)
        }

        currentTask = await Bot.getCurrentTask(id)
        if (!Bot.isRunning(id) || !currentTask) break

        await Bot.updateCurrentTaskLog(id, `#${counter}: Fetching account...`)

        const params = {
          token: currentTask.transactionData.token.token,
          mode: currentTask.mode,
          config: this.getConfig(currentTask.proxy),
          taskId: currentTask.id
        }

        if (!Bot.isRunning(id)) break

        const response = await customerApi.getProfile(params)

        if (!Bot.isRunning(id)) break

        if (response && response.error) {
          await this.handleError(id, counter, response.error, attr)
          continue
        } else if (response && !response.error && JSON.parse(response) && JSON.parse(response).addresses.length) {
          data = JSON.parse(response)
          break
        }
      } catch (error) {
        await Bot.updateCurrentTaskLog(id, `#${counter} at Line 639: ${error}`)
        continue
      }
    }

    return data
  },

  /**
   * Update user account
   *
   * @param {*} id
   * @param {*} attr
   * @returns
   */
  async updateAccount (id, attr = 'orange', account) {
    let data = null
    let counter = 0

    while (Bot.isRunning(id) && !data) {
      counter++

      try {
        let currentTask = await Bot.getCurrentTask(id)
        if (!Bot.isRunning(id) || !currentTask) break

        if (counter > 1) {
          let interval = null
          let timeout = null
          await new Promise((resolve) => {
            interval = setInterval(() => {
              timeout = setTimeout(() => {
                clearInterval(interval)
                resolve()
              }, currentTask.delay)
            }, 500)
          })
          clearInterval(interval)
          clearTimeout(timeout)
        }

        currentTask = await Bot.getCurrentTask(id)
        if (!Bot.isRunning(id) || !currentTask) break

        await Bot.updateCurrentTaskLog(id, `#${counter}: Updating account...`)

        const params = {
          token: currentTask.transactionData.token.token,
          mode: currentTask.mode,
          config: this.getConfig(currentTask.proxy),
          taskId: currentTask.id,
          payload: { customer: account }
        }

        if (!Bot.isRunning(id)) break

        const response = await customerApi.updateProfile(params)

        if (!Bot.isRunning(id)) break

        if (response && response.error) {
          await this.handleError(id, counter, response.error, attr)
          continue
        } else if (response && !response.error && JSON.parse(response) && JSON.parse(response).addresses.length) {
          data = JSON.parse(response)
          break
        }
      } catch (error) {
        await Bot.updateCurrentTaskLog(id, `#${counter} at Line 707: ${error}`)
        continue
      }
    }

    return data
  },

  /**
   * Perform Create, get, and clean cart
   *
   * @param {*} id
   */
  async initializeCart (id, attr = 'orange') {
    const cartId = await this.createCart(id, attr)

    let cart = null

    if (cartId) cart = await this.getCart(id, attr)

    return cart
  },

  /**
   * Perform cart creation
   *
   * @param {*} id
   */
  async createCart (id, attr = 'orange') {
    let data = null
    let counter = 0

    while (Bot.isRunning(id) && !data) {
      counter++

      try {
        let currentTask = await Bot.getCurrentTask(id)
        if (!Bot.isRunning(id) || !currentTask) break

        if (counter > 1) {
          let interval = null
          let timeout = null
          await new Promise((resolve) => {
            interval = setInterval(() => {
              timeout = setTimeout(() => {
                clearInterval(interval)
                resolve()
              }, currentTask.delay)
            }, 500)
          })
          clearInterval(interval)
          clearTimeout(timeout)
        }

        currentTask = await Bot.getCurrentTask(id)
        if (!Bot.isRunning(id) || !currentTask) break

        await Bot.setCurrentTaskStatus(id, { status: Constant.STATUS.RUNNING, msg: 'initializing cart', attr: attr })
        await Bot.updateCurrentTaskLog(id, `#${counter}: Creating cart...`)

        const params = {
          token: currentTask.transactionData.token.token,
          mode: currentTask.mode,
          config: this.getConfig(currentTask.proxy),
          taskId: currentTask.id
        }

        if (!Bot.isRunning(id)) break

        const response = await cartApi.create(params)

        if (!Bot.isRunning(id)) break

        if (response && response.error) {
          await this.handleError(id, counter, response.error, attr)
          continue
        } else if (response && !response.error) {
          data = JSON.parse(response)
          break
        }
      } catch (error) {
        await Bot.updateCurrentTaskLog(id, `#${counter} at Line 788: ${error}`)
        continue
      }
    }

    return data
  },

  /**
   * Fetch and clean current cart
   *
   * @param {*} id
   */
  async getCart (id, attr = 'orange') {
    let data = null
    let counter = 0
    let currentTask = await Bot.getCurrentTask(id)

    while (Bot.isRunning(id) && currentTask && !data) {
      counter++

      try {
        currentTask = await Bot.getCurrentTask(id)
        if (!Bot.isRunning(id) || !currentTask) break

        if (counter > 1) {
          let interval = null
          let timeout = null
          await new Promise((resolve) => {
            interval = setInterval(() => {
              timeout = setTimeout(() => {
                clearInterval(interval)
                resolve()
              }, currentTask.delay)
            }, 500)
          })
          clearInterval(interval)
          clearTimeout(timeout)
        }

        currentTask = await Bot.getCurrentTask(id)
        if (!Bot.isRunning(id) || !currentTask) break

        await Bot.setCurrentTaskStatus(id, { status: Constant.STATUS.RUNNING, msg: 'initializing cart', attr: attr })
        await Bot.updateCurrentTaskLog(id, `#${counter}: Getting cart...`)

        const params = {
          token: currentTask.transactionData.token.token,
          mode: currentTask.mode,
          config: this.getConfig(currentTask.proxy),
          taskId: currentTask.id
        }

        if (!Bot.isRunning(id)) break

        const response = await cartApi.get(params)

        if (!Bot.isRunning(id)) break

        if (response && response.error) {
          await this.handleError(id, counter, response.error, attr)
          continue
        } else if (response && !response.error) {
          data = JSON.parse(response)
          break
        }
      } catch (error) {
        await Bot.updateCurrentTaskLog(id, `#${counter} at Line 855: ${error}`)
        continue
      }
    }

    if (!Bot.isRunning(id)) return null

    // Clean cart
    if (data && data.items.length) {
      counter = 0

      for (let index = 0; index < data.items.length; index++) {
        let deleted = false

        while (Bot.isRunning(id) && !deleted) {
          counter++

          try {
            currentTask = await Bot.getCurrentTask(id)
            if (!Bot.isRunning(id) || !currentTask) break

            if (counter > 1) {
              let interval = null
              let timeout = null
              await new Promise((resolve) => {
                interval = setInterval(() => {
                  timeout = setTimeout(() => {
                    clearInterval(interval)
                    resolve()
                  }, currentTask.delay)
                }, 500)
              })
              clearInterval(interval)
              clearTimeout(timeout)
            }

            currentTask = await Bot.getCurrentTask(id)
            if (!Bot.isRunning(id) || !currentTask) break

            await Bot.setCurrentTaskStatus(id, { status: Constant.STATUS.RUNNING, msg: 'initializing cart', attr: attr })
            await Bot.updateCurrentTaskLog(id, `#${counter}: Cleaning cart - item ${index + 1}...`)

            const params = {
              token: currentTask.transactionData.token.token,
              id: data.items[index].item_id,
              mode: currentTask.mode,
              config: this.getConfig(currentTask.proxy),
              taskId: currentTask.id
            }

            if (!Bot.isRunning(id)) break

            const response = await cartApi.delete(params)

            if (!Bot.isRunning(id)) break

            if (response && response.error) {
              await this.handleError(id, counter, response.error)

              if (response.error && response.error.statusCode && response.error.statusCode === 404) deleted = true

              continue
            } else if (response && !response.error) {
              deleted = true
              continue
            }
          } catch (error) {
            await Bot.updateCurrentTaskLog(id, `#${counter} at Line 922: ${error}`)
            continue
          }
        }
      }
    }

    return data
  },

  /**
   * Add product to cart
   *
   * @param {*} id
   */
  async addToCart (id) {
    let data = null
    let counter = 0

    while (Bot.isRunning(id) && !data) {
      counter++

      try {
        let currentTask = await Bot.getCurrentTask(id)
        if (!Bot.isRunning(id) || !currentTask) break

        for (let index = 0; index < currentTask.sizes.length; index++) {
          try {
            currentTask = await Bot.getCurrentTask(id)
            if (!Bot.isRunning(id) || !currentTask) break

            if (counter > 1) {
              let interval = null
              let timeout = null
              await new Promise((resolve) => {
                interval = setInterval(() => {
                  timeout = setTimeout(() => {
                    clearInterval(interval)
                    resolve()
                  }, currentTask.delay)
                }, 500)
              })
              clearInterval(interval)
              clearTimeout(timeout)
            }

            currentTask = await Bot.getCurrentTask(id)
            if (!Bot.isRunning(id) || !currentTask) break

            const msg = `Size: ${currentTask.sizes[index].label.toUpperCase()} - trying`
            await Bot.setCurrentTaskStatus(id, { status: Constant.STATUS.RUNNING, msg: msg })
            await Bot.updateCurrentTaskLog(id, `#${counter}: ${msg}`)

            const params = {
              token: currentTask.transactionData.token.token,
              payload: {
                cartItem: {
                  qty: currentTask.qty || 1,
                  quote_id: currentTask.transactionData.cart.id,
                  sku: `${currentTask.sku}`,
                  product_type: 'configurable',
                  product_option: {
                    extension_attributes: {
                      configurable_item_options: [
                        {
                          option_id: currentTask.sizes[index].attribute_id.toString(),
                          option_value: parseInt(currentTask.sizes[index].value)
                        }
                      ]
                    }
                  },
                  extension_attributes: {}
                }
              },
              mode: currentTask.mode,
              config: this.getConfig(currentTask.proxy),
              taskId: currentTask.id
            }

            if (!Bot.isRunning(id)) break

            const response = await cartApi.store(params)

            currentTask = await Bot.getCurrentTask(id)
            if (!Bot.isRunning(id) || !currentTask) break

            if (response && response.error) {
              await this.handleError(id, counter, response.error)
              continue
            } else if (response && !response.error) {
              data = JSON.parse(response)
              data.size = currentTask.sizes[index].label.toUpperCase()

              const msg = `Size: ${currentTask.sizes[index].label.toUpperCase()} - carted`
              await Bot.setCurrentTaskStatus(id, { status: Constant.STATUS.RUNNING, msg: msg })
              await Bot.updateCurrentTaskLog(id, `#${counter}: ${msg}`)

              break
            } else {
              continue
            }
          } catch (error) {
            await Bot.updateCurrentTaskLog(id, `#${counter} at Line 1024: ${error}`)
            continue
          }
        }
      } catch (error) {
        await Bot.updateCurrentTaskLog(id, `#${counter} at Line 1029: ${error}`)
        continue
      }
    }

    return data
  },

  /**
   * Perform setting of shipping information
   *
   * @param {*} id
   */
  async setShippingInfo (id) {
    let data = null
    let counter = 0
    let currentTask = await Bot.getCurrentTask(id)

    if (!Bot.isRunning(id) || !currentTask) return data

    const email = currentTask.transactionData.account.email
    const defaultShippingAddress = currentTask.transactionData.account.addresses.find((val) => val.default_shipping)
    const defaultBillingAddress = currentTask.transactionData.account.addresses.find((val) => val.default_billing)

    // estimate shipping
    let params = null

    if (currentTask.transactionData.product.price <= 7000) {
      while (Bot.isRunning(id) && currentTask && !params) {
        counter++

        try {
          currentTask = await Bot.getCurrentTask(id)
          if (!Bot.isRunning(id) || !currentTask) break

          if (counter > 1) {
            let interval = null
            let timeout = null
            await new Promise((resolve) => {
              interval = setInterval(() => {
                timeout = setTimeout(() => {
                  clearInterval(interval)
                  resolve()
                }, currentTask.delay)
              }, 500)
            })
            clearInterval(interval)
            clearTimeout(timeout)
          }

          currentTask = await Bot.getCurrentTask(id)
          if (!Bot.isRunning(id) || !currentTask) break

          const waitingMsg = `Size: ${currentTask.transactionData.product.size} - estimating shipping`
          await Bot.setCurrentTaskStatus(id, { status: Constant.STATUS.RUNNING, msg: waitingMsg })
          await Bot.updateCurrentTaskLog(id, `#${counter}: ${waitingMsg}`)

          const parameters = {
            token: currentTask.transactionData.token.token,
            payload: { addressId: defaultShippingAddress.id },
            mode: currentTask.mode,
            config: this.getConfig(currentTask.proxy),
            taskId: currentTask.id
          }

          if (!Bot.isRunning(id)) break

          const response = await cartApi.estimateShipping(parameters)

          if (!Bot.isRunning(id)) break

          if (response && response.error) {
            await this.handleError(id, counter, response.error)

            if (response.error && response.error.statusCode && response.error.statusCode === 400) {
              currentTask = await Bot.getCurrentTask(id)
              delete currentTask.transactionData.cart
              await Tasks.dispatch('updateItem', currentTask)
              break
            } else {
              continue
            }
          } else if (response && !response.error) {
            params = JSON.parse(response)[0]
            break
          }
        } catch (error) {
          await Bot.updateCurrentTaskLog(id, `#${counter} at Line 1116: ${error}`)
          continue
        }
      }
    } else {
      params = {
        carrier_code: 'freeshipping',
        method_code: 'freeshipping'
      }
    }

    if (!Bot.isRunning(id) || !params) return data

    // set shipping
    const shippingAddress = await this.setAddresses(defaultShippingAddress, email)
    const billingAddress = await this.setAddresses(defaultBillingAddress, email)

    const payload = {
      addressInformation: {
        shipping_address: shippingAddress,
        billing_address: billingAddress,
        shipping_method_code: params.method_code,
        shipping_carrier_code: params.carrier_code
      }
    }

    counter = 0

    while (Bot.isRunning(id) && !data) {
      counter++

      try {
        currentTask = await Bot.getCurrentTask(id)
        if (!Bot.isRunning(id) || !currentTask) break

        if (counter > 1) {
          let interval = null
          let timeout = null
          await new Promise((resolve) => {
            interval = setInterval(() => {
              timeout = setTimeout(() => {
                clearInterval(interval)
                resolve()
              }, currentTask.delay)
            }, 500)
          })
          clearInterval(interval)
          clearTimeout(timeout)
        }

        currentTask = await Bot.getCurrentTask(id)
        if (!Bot.isRunning(id) || !currentTask) break

        const waitingMsg = `Size: ${currentTask.transactionData.product.size} - setting shipping details`
        await Bot.setCurrentTaskStatus(id, { status: Constant.STATUS.RUNNING, msg: waitingMsg })
        await Bot.updateCurrentTaskLog(id, `#${counter}: ${waitingMsg}`)

        const params = {
          token: currentTask.transactionData.token.token,
          payload: payload,
          mode: currentTask.mode,
          config: this.getConfig(currentTask.proxy),
          taskId: currentTask.id
        }

        if (!Bot.isRunning(id)) break

        const response = await cartApi.setShippingInformation(params)

        if (!Bot.isRunning(id)) break

        if (response && response.error) {
          await this.handleError(id, counter, response.error)

          if (response.error && response.error.statusCode && response.error.statusCode === 400) {
            currentTask = await Bot.getCurrentTask(id)
            delete currentTask.transactionData.cart
            await Tasks.dispatch('updateItem', currentTask)
            break
          } else {
            continue
          }
        } else if (response && !response.error) {
          data = JSON.parse(response)
          break
        }
      } catch (error) {
        await Bot.updateCurrentTaskLog(id, `#${counter} at Line 1203: ${error}`)
        continue
      }
    }

    return data
  },

  /**
   * Perform placing of order
   *
   * @param {*} id
   */
  async placeOrder (id) {
    let data = null

    try {
      let currentTask = await Bot.getCurrentTask(id)
      if (!Bot.isRunning(id) || !currentTask) return data

      const waitingMsg = `Size: ${currentTask.transactionData.product.size} - waiting to place order`
      await Bot.setCurrentTaskStatus(id, { status: Constant.STATUS.RUNNING, msg: waitingMsg })
      await Bot.updateCurrentTaskLog(id, waitingMsg)

      if (currentTask.placeOrder) {
        let interval = null
        let timeout = null
        const vm = this
        await new Promise((resolve) => {
          interval = setInterval(() => {
            const now = new Date()
            const then = new Date(moment(currentTask.placeOrder, 'HH:mm:ss').format('YYYY-MM-DD HH:mm:ss'))
            timeout = setTimeout(() => {
              vm.removeTimer(id)
              clearInterval(interval)
              resolve()
            }, then - now)
          }, 500)
        })
        clearInterval(interval)
        clearTimeout(timeout)
      }

      currentTask = await Bot.getCurrentTask(id)
      if (!Bot.isRunning(id) || !currentTask) return data

      const placingMsg = `Size: ${currentTask.transactionData.product.size} - placing order`
      await Bot.setCurrentTaskStatus(id, { status: Constant.STATUS.RUNNING, msg: placingMsg })
      await Bot.updateCurrentTaskLog(id, placingMsg)

      const defaultBillingAddress = currentTask.transactionData.account.addresses.find((val) => val.default_billing)

      const payload = {
        payload: {
          billingAddress: this.setAddresses(defaultBillingAddress, currentTask.transactionData.account.email),
          cardId: currentTask.transactionData.cart.id.toString(),
          paymentMethod: {
            method: '',
            po_number: null,
            additional_data: null
          }
          // amcheckout: {}
        },
        token: currentTask.transactionData.token.token,
        mode: currentTask.mode,
        config: this.getConfig(currentTask.proxy),
        taskId: currentTask.id
      }

      switch (currentTask.checkoutMethod) {
        case 1:
          payload.payload.paymentMethod.method = 'paymaya_checkout'
          data = await this.paymayaCheckout(id, payload)
          break

        case 2:
          payload.payload.paymentMethod.method = 'ccpp'
          data = await this.creditCardCheckout(id, payload)
          break

        case 3:
          payload.payload.paymentMethod.method = 'braintree_paypal'

          if (currentTask.account.paypal && currentTask.account.paypal.account) {
            payload.payload.paymentMethod.additional_data = {
              paypal_express_checkout_token: currentTask.account.paypal.token,
              paypal_express_checkout_redirect_required: false,
              paypal_express_checkout_payer_id: currentTask.account.paypal.PayerID,
              payment_method_nonce: currentTask.account.paypal.account.paypalAccounts[0].nonce
            }
          }

          data = await this.paypalCheckout(id, payload)
          break

        default:
          switch (currentTask.transactionData.shipping.payment_methods.slice().find((val) => val.code).code) {
            case 'paymaya_checkout':
              payload.payload.paymentMethod.method = 'paymaya_checkout'
              data = await this.paymayaCheckout(id, payload)
              break

            case 'ccpp':
              payload.payload.paymentMethod.method = 'ccpp'
              data = await this.creditCardCheckout(id, payload)
              break

            case 'braintree_paypal':
              payload.payload.paymentMethod.method = 'braintree_paypal'

              if (currentTask.account.paypal && currentTask.account.paypal.account) {
                payload.payload.paymentMethod.additional_data = {
                  paypal_express_checkout_token: currentTask.account.paypal.token,
                  paypal_express_checkout_redirect_required: false,
                  paypal_express_checkout_payer_id: currentTask.account.paypal.PayerID,
                  payment_method_nonce: currentTask.account.paypal.account.paypalAccounts[0].nonce
                }
              }

              data = await this.paypalCheckout(id, payload)

              break
          }
          break
      }
    } catch (error) {
      await Bot.updateCurrentTaskLog(id, `Line 1329: ${error}`)
    }

    return data
  },

  /**
   * PayMaya checkout method
   *
   * @param {*} id
   * @param {*} payload
   */
  async paymayaCheckout (id, payload) {
    let data = null
    const tries = 3
    let currentTask = await Bot.getCurrentTask(id)

    for (let index = 1; index <= tries; index++) {
      try {
        currentTask = await Bot.getCurrentTask(id)
        if (!Bot.isRunning(id) || !currentTask) break

        if (index > 1) {
          const waitingMsg = `Size: ${currentTask.transactionData.product.size} - retrying`
          await Bot.setCurrentTaskStatus(id, { status: Constant.STATUS.RUNNING, msg: waitingMsg })
          await Bot.updateCurrentTaskLog(id, waitingMsg)
        }

        let counter = 0

        while (Bot.isRunning(id) && currentTask && !data) {
          counter++

          currentTask = await Bot.getCurrentTask(id)
          if (!Bot.isRunning(id) || !currentTask) break

          if (counter > 1) {
            let interval = null
            let timeout = null
            await new Promise((resolve) => {
              interval = setInterval(() => {
                timeout = setTimeout(() => {
                  clearInterval(interval)
                  resolve()
                }, currentTask.delay)
              }, 500)
            })
            clearInterval(interval)
            clearTimeout(timeout)
          }

          if (!Bot.isRunning(id)) break

          const timer = new StopWatch(true)

          const response = await cartApi.paymentInformation(payload)

          timer.stop()

          const speed = (timer.read() / 1000.0).toFixed(2)

          currentTask = await Bot.getCurrentTask(id)
          if (!Bot.isRunning(id) || !currentTask) break

          currentTask.transactionData.timer = speed

          await Tasks.dispatch('updateItem', currentTask)

          if (response && response.error) {
            await this.handleError(id, counter, response.error)

            if (response.error.statusCode !== 429) break

            continue
          } else if (response && !response.error) {
            const params = {
              mode: currentTask.mode,
              config: payload.config,
              taskId: currentTask.id
            }

            const order = await orderApi.paymaya(params)

            if (!Bot.isRunning(id)) break

            data = order.request.uri.href
            break
          }
        }

        if (data) break
      } catch (error) {
        await Bot.updateCurrentTaskLog(id, `Line 1421: ${error}`)
        continue
      }
    }

    currentTask = await Bot.getCurrentTask(id)
    if (!Bot.isRunning(id) || !currentTask) return null

    if (!data) {
      const msg = `Size: ${currentTask.transactionData.product.size} - out of luck`
      await Bot.setCurrentTaskStatus(id, { status: Constant.STATUS.RUNNING, msg: msg })
      await Bot.updateCurrentTaskLog(id, msg)
    } else {
      const msg = `Size: ${currentTask.transactionData.product.size} - copped!`
      const img = await this.searchProduct(id)

      currentTask.transactionData.product.image = img
      currentTask.transactionData.checkoutLink = data
      currentTask.transactionData.method = 'PayMaya'
      currentTask.status = {
        id: Constant.STATUS.RUNNING,
        msg: msg,
        class: 'success'
      }

      await Bot.updateCurrentTaskLog(id, msg)
      await Tasks.dispatch('updateItem', currentTask)
    }

    return data
  },

  /**
   * 2c2p checkout method
   *
   * @param {*} id
   * @param {*} payload
   */
  async creditCardCheckout (id, payload) {
    let data = null
    const tries = 3
    let currentTask = await Bot.getCurrentTask(id)

    for (let index = 1; index <= tries; index++) {
      try {
        currentTask = await Bot.getCurrentTask(id)
        if (!Bot.isRunning(id) || !currentTask) break

        if (index > 1) {
          const waitingMsg = `Size: ${currentTask.transactionData.product.size} - retrying`
          await Bot.setCurrentTaskStatus(id, { status: Constant.STATUS.RUNNING, msg: waitingMsg })
          await Bot.updateCurrentTaskLog(id, waitingMsg)
        }

        let counter = 0

        while (Bot.isRunning(id) && currentTask && !data) {
          counter++

          currentTask = await Bot.getCurrentTask(id)
          if (!Bot.isRunning(id) || !currentTask) break

          if (counter > 1) {
            let interval = null
            let timeout = null
            await new Promise((resolve) => {
              interval = setInterval(() => {
                timeout = setTimeout(() => {
                  clearInterval(interval)
                  resolve()
                }, currentTask.delay)
              }, 500)
            })
            clearInterval(interval)
            clearTimeout(timeout)
          }

          if (!Bot.isRunning(id)) break

          const timer = new StopWatch(true)

          const response = await cartApi.paymentInformation(payload)

          timer.stop()

          const speed = (timer.read() / 1000.0).toFixed(2)

          currentTask = await Bot.getCurrentTask(id)
          if (!Bot.isRunning(id) || !currentTask) break

          currentTask.transactionData.timer = speed

          await Tasks.dispatch('updateItem', currentTask)

          if (response && response.error) {
            await this.handleError(id, counter, response.error)

            if (response.error.statusCode !== 429) break

            continue
          } else if (response && !response.error) {
            const params = {
              token: currentTask.transactionData.token.token,
              mode: currentTask.mode,
              config: payload.config,
              taskId: currentTask.id
            }

            const order = await orderApi.getTransactionData(params)

            currentTask = await Bot.getCurrentTask(id)
            if (!Bot.isRunning(id) || !currentTask) break

            if (order && order.error) {
              await this.handleError(id, counter, order.error)

              if (order.error.statusCode !== 429) break

              continue
            } else if (order && !order.error) {
              const params = {
                mode: currentTask.mode,
                config: payload.config,
                taskId: currentTask.id
              }

              let orderNumber = null
              const parameters = {}
              const fieldRecords = JSON.parse(order).fields
              const valueRecords = JSON.parse(order).values

              for (let index = 0; index < fieldRecords.length; index++) {
                parameters[fieldRecords[index]] = valueRecords[index]
                if (fieldRecords[index] === 'order_id') orderNumber = valueRecords[index]
              }

              params.form = parameters

              const cookieResponse = await orderApi.place2c2pOrder(params)

              currentTask = await Bot.getCurrentTask(id)
              if (!Bot.isRunning(id) || !currentTask) break

              let cookie = null

              await cookieResponse.error.options.jar._jar.store.getAllCookies((err, cookieArray) => {
                if (err) cookie = null

                cookie = cookieArray.find((val) => val.key === 'ASP.NET_SessionId')
              })

              data = {
                cookie: {
                  name: 'ASP.NET_SessionId',
                  value: cookie.value,
                  domain: '.2c2p.com',
                  expiry: cookie.expiry
                },
                data: orderNumber
              }

              break
            }
          }
        }

        if (data) break
      } catch (error) {
        await Bot.updateCurrentTaskLog(id, `Line 1589: ${error}`)
        continue
      }
    }

    currentTask = await Bot.getCurrentTask(id)
    if (!Bot.isRunning(id) || !currentTask) return null

    if (!data) {
      const msg = `Size: ${currentTask.transactionData.product.size} - out of luck`
      await Bot.setCurrentTaskStatus(id, { status: Constant.STATUS.RUNNING, msg: msg })
      await Bot.updateCurrentTaskLog(id, msg)
    } else {
      const msg = `Size: ${currentTask.transactionData.product.size} - copped!`
      const img = await this.searchProduct(id)

      currentTask.transactionData.product.image = img
      currentTask.transactionData.cookie = data.cookie
      currentTask.transactionData.method = '2c2p'
      currentTask.transactionData.order = data.data
      currentTask.status = {
        id: Constant.STATUS.RUNNING,
        msg: msg,
        class: 'success'
      }

      await Bot.updateCurrentTaskLog(id, msg)
      await Tasks.dispatch('updateItem', currentTask)
    }

    return data
  },

  /**
   * PayPal checkout method
   *
   * @param {*} id
   * @param {*} payload
   */
  async paypalCheckout (id, payload) {
    let data = null
    const tries = 3
    let currentTask = await Bot.getCurrentTask(id)

    for (let index = 1; index <= tries; index++) {
      try {
        currentTask = await Bot.getCurrentTask(id)
        if (!Bot.isRunning(id) || !currentTask) break

        if (index > 1) {
          const waitingMsg = `Size: ${currentTask.transactionData.product.size} - retrying`
          await Bot.setCurrentTaskStatus(id, { status: Constant.STATUS.RUNNING, msg: waitingMsg })
          await Bot.updateCurrentTaskLog(id, waitingMsg)
        }

        let counter = 0

        while (Bot.isRunning(id) && currentTask && !data) {
          counter++

          currentTask = await Bot.getCurrentTask(id)
          if (!Bot.isRunning(id) || !currentTask) break

          if (counter > 1) {
            let interval = null
            let timeout = null
            await new Promise((resolve) => {
              interval = setInterval(() => {
                timeout = setTimeout(() => {
                  clearInterval(interval)
                  resolve()
                }, currentTask.delay)
              }, 500)
            })
            clearInterval(interval)
            clearTimeout(timeout)
          }

          if (!Bot.isRunning(id)) break

          const timer = new StopWatch(true)

          const response = await cartApi.paymentInformation(payload)

          timer.stop()

          const speed = (timer.read() / 1000.0).toFixed(2)

          currentTask = await Bot.getCurrentTask(id)
          if (!Bot.isRunning(id) || !currentTask) break

          currentTask.transactionData.timer = speed

          await Tasks.dispatch('updateItem', currentTask)

          if (response && response.error) {
            await this.handleError(id, counter, response.error)

            if (response.error.statusCode !== 429) break

            continue
          } else if (response && !response.error) {
            data = response
            break
          }
        }

        if (data) break
      } catch (error) {
        await Bot.updateCurrentTaskLog(id, `Line 1698: ${error}`)
        continue
      }
    }

    currentTask = await Bot.getCurrentTask(id)
    if (!Bot.isRunning(id) || !currentTask) return null

    if (!data) {
      const msg = `Size: ${currentTask.transactionData.product.size} - out of luck`
      await Bot.setCurrentTaskStatus(id, { status: Constant.STATUS.RUNNING, msg: msg })
      await Bot.updateCurrentTaskLog(id, msg)
    } else {
      const msg = `Size: ${currentTask.transactionData.product.size} - copped!`
      const img = await this.searchProduct(id)

      currentTask.transactionData.product.image = img
      currentTask.transactionData.method = 'PayPal'
      currentTask.status = {
        id: Constant.STATUS.RUNNING,
        msg: msg,
        class: 'success'
      }

      await Accounts.dispatch('updateItem', {
        ...currentTask.account,
        paypal: {
          ...currentTask.account.paypal,
          account: null,
          expires_in: null
        }
      })
      await Bot.updateCurrentTaskLog(id, msg)
      await Tasks.dispatch('updateItem', currentTask)
    }

    return data
  },

  /**
   * Perform product search
   *
   * @param {*} id
   */
  async searchProduct (id) {
    let data = null

    const currentTask = await Bot.getCurrentTask(id)
    if (!Bot.isRunning(id) || !currentTask) return data

    const params = {
      payload: {
        searchCriteria: {
          filterGroups: [
            {
              filters: [
                {
                  field: 'sku',
                  value: currentTask.sku.toUpperCase()
                }
              ]
            }
          ]
        }
      },
      token: Config.services.titan22.token,
      mode: currentTask.mode,
      config: this.getConfig(currentTask.proxy),
      taskId: currentTask.id
    }

    const response = await productApi.search(params)

    if (response && !response.error) {
      try {
        const image = JSON.parse(response).items[0].custom_attributes.find((val) => val.attribute_code === 'image')
        data = `${Config.services.titan22.url}/media/catalog/product${image.value}`
      } catch (error) {
        data = ''
      }
    }

    return data
  },

  /**
   * Perform on success event
   *
   * @param {*} id
   */
  async onSuccess (id) {
    const currentTask = await Bot.getCurrentTask(id)
    if (!Bot.isRunning(id) || !currentTask) return false

    delete currentTask.transactionData.token
    delete currentTask.transactionData.account
    delete currentTask.transactionData.cart

    currentTask.status = {
      ...currentTask.status,
      id: Constant.STATUS.STOPPED
    }

    await Tasks.dispatch('updateItem', currentTask)
    await Bot.updateCurrentTaskLog(id, '====================')

    if (currentTask.autoPay) this.redirectToCheckout(id)

    if (Settings.state.items.withSound) {
      const sound = new Howl({
        src: [SuccessEffect]
      })
      sound.play()
    }

    Toastify({
      text: 'Checkout!',
      duration: 3000,
      newWindow: true,
      close: false,
      gravity: 'bottom',
      position: 'right',
      backgroundColor: '#228B22',
      className: 'toastify'
    }).showToast()

    const webhook = {
      productName: currentTask.transactionData.product.name,
      productSku: currentTask.transactionData.product.sku,
      productImage: currentTask.transactionData.product.image,
      checkoutMethod: currentTask.transactionData.method,
      checkoutTime: currentTask.transactionData.timer,
      delay: currentTask.delay
    }

    await new Promise(resolve => setTimeout(resolve, 3000))

    // send to personal webhook
    if (Settings.state.items.webhookUrl) {
      const personalWebhook = {
        ...webhook,
        url: Settings.state.items.webhookUrl,
        accountName: currentTask.account.name,
        checkoutLink: (currentTask.transactionData.method === 'PayMaya') ? currentTask.transactionData.checkoutLink : '',
        checkoutCookie: (currentTask.transactionData.cookie) ? currentTask.transactionData.cookie.value : '',
        proxyList: currentTask.proxy.name,
        orderNumber: currentTask.transactionData.order,
        mode: currentTask.mode.label
      }
      Webhook.sendWebhook(personalWebhook)
    }

    // send to public webhook
    const publicWebhook = {
      ...webhook,
      url: Config.bot.webhook
    }
    Webhook.sendWebhook(publicWebhook)
  },

  /**
   * Proceed to checkout page
   *
   * @param {*} id
   */
  async redirectToCheckout (id) {
    const currentTask = await Bot.getCurrentTask(id)

    switch (currentTask.transactionData.method) {
      case 'PayMaya':
        PayMayaCheckout.automate(id)
        break
      case '2c2p':
        CreditCardCheckout.automate(id)
        break
    }
  }
}
