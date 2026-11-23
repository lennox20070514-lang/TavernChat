import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type {
  ChatMessage,
  ChatSession,
  ComponentItem,
  StorageAdapter,
} from '@tavern-chat/core'

interface TavernDbSchema extends DBSchema {
  components: {
    key: string
    value: ComponentItem
    indexes: { 'by-kind': string; 'by-updated': number }
  }
  sessions: {
    key: string
    value: ChatSession
    indexes: { 'by-updated': number }
  }
  messages: {
    key: string
    value: ChatMessage
    indexes: { 'by-session': string }
  }
}

const DB_NAME = 'tavernchat-local-v1'
const DB_VERSION = 1

export class IndexedDbStorageAdapter implements StorageAdapter {
  readonly mode = 'indexeddb' as const
  private dbPromise: Promise<IDBPDatabase<TavernDbSchema>> | null = null

  private getDb(): Promise<IDBPDatabase<TavernDbSchema>> {
    if (!this.dbPromise) {
      this.dbPromise = openDB<TavernDbSchema>(DB_NAME, DB_VERSION, {
        upgrade(db) {
          if (!db.objectStoreNames.contains('components')) {
            const store = db.createObjectStore('components', { keyPath: 'id' })
            store.createIndex('by-kind', 'kind')
            store.createIndex('by-updated', 'updatedAt')
          }
          if (!db.objectStoreNames.contains('sessions')) {
            const store = db.createObjectStore('sessions', { keyPath: 'id' })
            store.createIndex('by-updated', 'updatedAt')
          }
          if (!db.objectStoreNames.contains('messages')) {
            const store = db.createObjectStore('messages', { keyPath: 'id' })
            store.createIndex('by-session', 'sessionId')
          }
        },
      })
    }
    return this.dbPromise
  }

  async listComponents(): Promise<ComponentItem[]> {
    const db = await this.getDb()
    const items = await db.getAll('components')
    return items.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async upsertComponent(item: ComponentItem): Promise<void> {
    const db = await this.getDb()
    await db.put('components', item)
  }

  async deleteComponent(id: string): Promise<void> {
    const db = await this.getDb()
    await db.delete('components', id)
  }

  async listSessions(): Promise<ChatSession[]> {
    const db = await this.getDb()
    const items = await db.getAll('sessions')
    return items.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async upsertSession(session: ChatSession): Promise<void> {
    const db = await this.getDb()
    await db.put('sessions', session)
  }

  async deleteSession(id: string): Promise<void> {
    const db = await this.getDb()
    const tx = db.transaction(['sessions', 'messages'], 'readwrite')
    await tx.objectStore('sessions').delete(id)
    const msgStore = tx.objectStore('messages')
    const keys = await msgStore.index('by-session').getAllKeys(id)
    for (const key of keys) {
      await msgStore.delete(key)
    }
    await tx.done
  }

  async listMessages(sessionId: string): Promise<ChatMessage[]> {
    const db = await this.getDb()
    const items = await db.getAllFromIndex('messages', 'by-session', sessionId)
    return items.sort((a, b) => a.createdAt - b.createdAt)
  }

  async listAllMessages(): Promise<ChatMessage[]> {
    const db = await this.getDb()
    return db.getAll('messages')
  }

  async upsertMessage(message: ChatMessage): Promise<void> {
    const db = await this.getDb()
    await db.put('messages', message)
  }

  async deleteMessages(_sessionId: string, messageIds: string[]): Promise<void> {
    const db = await this.getDb()
    const tx = db.transaction('messages', 'readwrite')
    for (const id of messageIds) {
      await tx.store.delete(id)
    }
    await tx.done
  }

  async clearAll(): Promise<void> {
    const db = await this.getDb()
    const tx = db.transaction(['components', 'sessions', 'messages'], 'readwrite')
    await Promise.all([
      tx.objectStore('components').clear(),
      tx.objectStore('sessions').clear(),
      tx.objectStore('messages').clear(),
    ])
    await tx.done
  }
}

export const storage = new IndexedDbStorageAdapter()
