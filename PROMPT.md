# Limitless Software factory

## Purpose

I would like to build a software factory -- I'd like to be able to give the system an arbitrary prompt and have it build excellent quality software while still being conscious of price / usage of my AI accounts.

I wish to use this system to write new features and maintain existing software for both work and home projects.

## Methodology

1. You should be doing research prior to building. I expect a solution that includes the best ideas in autonomous building. These should not be limited to information already in your training data.
2. Choose carefully when to involve the human (me!) in your decisions. Your human operator has almost 32 years of experience as a software engineer and is heavily steeped in backend coding, infrastructure, and architecture in general. I am happy to answer any questions necessary to clarify what you should build. I will answer questions about architecture, but I am putting you in charge of architecture because I'd like to see how well you can build something on its own. If you need access to an account or system, please ask, I'm happy to help!
3. You should build in systems to ensure quality as early as possible. Code reviews, adversarial reviews, review of whether the solution matches the original intent, linting, unit tests, will help us avoid dead ends.
4. You should seek to make this system "self hosting" as soon as possible. Essentially, you are the orchestrator of a system building itself. That will involve direct oversight from you -- you are responsible for the output of the system for every version of the self hosted system.
5. In the next section I will give you an outline of the resources available to you. Use them wisely to maximize the amount of work you can get done.
6. You should plan milestones that you feel are appropriate. If there is progress that I can see in any of those milestones, I would like for you to demo that progress to me before you continue. You should spend time to prepare a demo that allows me to quickly understand what you've done -- I'm less interested in reading a lot of code unless that code is truly unique in some way. I am interested in architecture.
7. Please commit as you see fit

## Resources Available

Here are the resources at your disposal:

1. The claude account you are currently using. It is the $100 claude 5x account. You are using the Opus 5.5 model currently, but you can use any model you feel is appropriate. If you feel that we need to upgrade to a 20x account, we can discuss it.
2. My OpenAI account. It is the $100 pro plan, similar to the claude 5x account. Please try to leave at least 10% of the usage available so I can continue to use it for other tasks.
3. My OpenRouter account -- you can use up to $50 in credits. If you are going to exceed $50, please alert me and we can discuss whether you can have more.
4. This machine's GPU. It is an M5 Macbook Pro with various models available such as Qwen 3.8 27B and Qwen 3.8 Flash-Next. You can run these models through mtplx. This usage is free, but the models are not as powerful as what you want to build. I also have unsloth studio available and I'm happy to download any model that this machine can run.
5. Another machine's GPU. The other machine (twilight) has an NVIDIA RTX 5090 with 32 gigs of vram, making it capable of running additional useful models.

You will probably need me to do some setup for you to be able to utilize 3 or 5, please ask if you decide to use them.

Keep in mind that when using a less capable model that it may need you to more fully develop the prompt to account for its relative lack of intelligence.

## Required Functionality

1. Ability to trigger new runs via a chat interface
2. Ability to trigger new runs via webhooks (for example, from GitHub webhooks)
3. Ability to trigger new runs via discord
4. Selection of a model that is capable for the task, but for a well optimized price. For example, if I had a trigger from Dependabot it would seem that an open source model could probably handle that for free!
5. Ability to fall back to other providers if one is not available
6. A UI that exposes what is in progress, the cost, any errors, the performance of a run, and the ability to kick off new runs. The UI should have enough information to allow me to diagnose what happens when errors occur. It should also be able to cancel runs.
7. MCP or skills that integrate into existing agents (especially Claude and OpenAI)
8. Documentation that is clear for humans to read and that fully explains how to use the system.

Functionality should not be limited to these ideas. You should be researching competitors and shameless stealing the best ideas you can find.

## Codebase Structure

I do like bun, typescript, SolidJS, and SQLite. If it doesn't matter, use those. If it does matter at all choose whatever is appropriate for the situation.

## How to Know you are Done

1. You have been able to use the software factory yourself to complete tasks without errors.
2. You have completed the items listed in the "Required Functionality" section.
