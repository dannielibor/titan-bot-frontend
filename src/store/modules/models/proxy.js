import Constant from '@/config/constant'

export default {
  namespaced: true,
  state () {
    return {
      items: localStorage.getItem('proxies')
        ? JSON.parse(localStorage.getItem('proxies'))
        : []
    }
  },

  mutations: {
    /**
     * Store all items.
     *
     * @param {*} state
     * @param {*} items
     */
    SET_ITEMS (state, items) {
      state.items = items
    }
  },

  actions: {
    /**
     * Trigger store items.
     *
     * @param {*} param
     * @param {*} items
     */
    setItems ({ commit }, items) {
      commit('SET_ITEMS', items)
      localStorage.setItem('proxies', JSON.stringify(items))
    },

    /**
     * Trigger add item.
     *
     * @param {*} param
     * @param {*} item
     */
    addItem ({ state, commit }, item) {
      const proxies = state.items.slice()
      const id = (proxies.length) ? proxies.length + 1 : 1

      proxies.push({
        id: id,
        ...item,
        name: (item.name) ? item.name.trim() : `Proxy List ${id}`,
        configs: [],
        status: Constant.STATUS.STOPPED,
        loading: false
      })

      commit('SET_ITEMS', proxies)
      localStorage.setItem('proxies', JSON.stringify(proxies))
    },

    /**
     * Trigger update item.
     *
     * @param {*} param
     */
    updateItem ({ state, commit }, params) {
      let proxies = state.items.slice()

      proxies = proxies.map((val) => {
        if (val.id === params.id) val = params

        return val
      })

      commit('SET_ITEMS', proxies)
      localStorage.setItem('proxies', JSON.stringify(proxies))
    },

    /**
     * Trigger delete item.
     *
     * @param {*} param
     * @param {*} key
     */
    deleteItem ({ state, commit }, key) {
      const proxies = state.items.slice()

      proxies.splice(key, 1)

      commit('SET_ITEMS', proxies)
      localStorage.setItem('proxies', JSON.stringify(proxies))
    },

    /**
     * Initialize items
     */
    init ({ state, commit }) {
      let proxies = state.items.slice()

      proxies = proxies.map((val) => {
        val.status = Constant.STATUS.STOPPED
        val.loading = false

        return val
      })

      commit('SET_ITEMS', proxies)
      localStorage.setItem('proxies', JSON.stringify(proxies))
    }
  }
}
