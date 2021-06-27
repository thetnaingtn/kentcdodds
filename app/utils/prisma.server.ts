import {PrismaClient, Team} from '@prisma/client'
import type {User, Session} from 'types'
import {encrypt, decrypt} from './encryption.server'

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace NodeJS {
    interface Global {
      prisma?: PrismaClient
    }
  }
}

// this is to prevent us from making multiple connectsion during dev:
const prisma = getPrismaClient()

function getPrismaClient() {
  if (process.env.NODE_ENV === 'production') {
    return new PrismaClient()
  }
  if (global.prisma) return global.prisma
  global.prisma = new PrismaClient()
  return global.prisma
}

const linkExpirationTime = 1000 * 60 * 30
const sessionExpirationTime = 1000 * 60 * 60 * 24 * 30

const isProd = process.env.NODE_ENV === 'production'

const {DATABASE_URL} = process.env
if (!isProd && DATABASE_URL && !DATABASE_URL.includes('localhost')) {
  // if we're connected to a non-localhost db, let's make
  // sure we know it.
  const domain = new URL(DATABASE_URL)
  if (domain.password) {
    domain.password = '**************'
  }
  console.warn(
    `
⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️
Connected to non-localhost DB in dev mode:
  ${domain.toString()}
⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️
    `.trim(),
  )
}

const magicLinkSearchParam = 'kodyKey'

function getMagicLink({
  emailAddress,
  domainUrl,
}: {
  emailAddress: string
  domainUrl: string
}) {
  const expirationDate = new Date(Date.now() + linkExpirationTime).toISOString()
  const stringToEncrypt = JSON.stringify([emailAddress, expirationDate])
  const encryptedString = encrypt(stringToEncrypt)
  const url = new URL(domainUrl)
  url.pathname = 'magic'
  url.searchParams.set(magicLinkSearchParam, encryptedString)
  return url.toString()
}

async function validateMagicLink(validationEmailAddress: string, link: string) {
  let email, linkExpirationString
  try {
    const url = new URL(link)
    const encryptedString = url.searchParams.get(magicLinkSearchParam) ?? '[]'
    const decryptedString = decrypt(encryptedString)
    ;[email, linkExpirationString] = JSON.parse(decryptedString)
  } catch (error: unknown) {
    console.error(error)
    throw new Error('Invalid magic link.')
  }

  if (typeof email !== 'string') {
    console.error(`Email is not a string. Maybe wasn't set in the session?`)
    throw new Error('Invalid magic link.')
  }

  if (typeof linkExpirationString !== 'string') {
    console.error('Link expiration is not a string.')
    throw new Error('Invalid magic link.')
  }

  if (email !== validationEmailAddress) {
    console.error(
      `The email for a magic link doesn't match the one in the session.`,
    )
    throw new Error('Invalid magic link.')
  }

  const linkExpirationDate = new Date(linkExpirationString)
  if (Date.now() > linkExpirationDate.getTime()) {
    throw new Error('Magic link expired. Please request a new one.')
  }
}

async function createSession(
  sessionData: Omit<Session, 'id' | 'expirationDate' | 'createdAt'>,
) {
  return prisma.session.create({
    data: {
      ...sessionData,
      expirationDate: new Date(Date.now() + sessionExpirationTime),
    },
  })
}

async function getUserFromSessionId(sessionId: string) {
  const session = await prisma.session.findUnique({
    where: {id: sessionId},
    include: {user: true},
  })
  if (!session) {
    throw new Error('No user found')
  }

  if (Date.now() > session.expirationDate.getTime()) {
    throw new Error('Session expired. Please request a new magic link.')
  }

  return session.user
}

function getUserByEmail(email: string) {
  return prisma.user.findUnique({where: {email}})
}

function updateUser(
  userId: string,
  updatedInfo: Omit<
    Partial<User>,
    'id' | 'email' | 'team' | 'createdAt' | 'updatedAt'
  >,
) {
  return prisma.user.update({where: {id: userId}, data: updatedInfo})
}

async function addPostRead({slug, userId}: {slug: string; userId: string}) {
  const readInLastWeek = await prisma.postRead.findFirst({
    select: {id: true},
    where: {
      userId,
      postSlug: slug,
      createdAt: {gt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 7)},
    },
  })
  if (readInLastWeek) {
    return null
  } else {
    const postRead = await prisma.postRead.create({
      data: {postSlug: slug, userId},
      select: {id: true},
    })
    return postRead
  }
}

const teams: Array<Team> = Object.values(Team)

export {
  prisma,
  getMagicLink,
  validateMagicLink,
  createSession,
  getUserFromSessionId,
  teams,
  getUserByEmail,
  updateUser,
  addPostRead,
}
